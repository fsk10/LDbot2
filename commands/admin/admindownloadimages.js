const { Client, ChannelType } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { isAdmin } = require('../../utils/permissions');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const axios = require('axios');
const logger = require('../../utils/logger');
const { DateTime } = require('luxon');

const commandData = new SlashCommandBuilder()
    .setName('admindownloadimages')
    .setDescription('Download all images from a specified channel')
    .addChannelOption(option => 
        option.setName('channel')
            .setDescription('The channel to download images from')
            .setRequired(true));

async function execute(interaction, client) {
    // Check if the user has admin permissions
    const userIsAdmin = await isAdmin(interaction);

    if (!userIsAdmin) {
        // Inform the user that they don't have the required permissions
        const permissionErrorEmbed = new EmbedBuilder()
            .setTitle('Permission Denied')
            .setDescription("You don't have the required permissions to use this command.")
            .setColor('#FF0000');

        return interaction.reply({ embeds: [permissionErrorEmbed], ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel');
    console.log(`Channel ID: ${channel.id}, Channel Type: ${channel.type}`);

    if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'Please provide a valid text channel.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const messages = await fetchMessages(channel);
        const userImageMap = extractImageUrlsByUser(messages);

        if (Object.keys(userImageMap).length === 0) {
            return interaction.editReply({ content: 'No images found in the specified channel.', ephemeral: true });
        }

        // Download images to local filesystem first
        const imagesDir = path.join(__dirname, '../../downloads/images');
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }

        const feedbackEmbed = new EmbedBuilder()
            .setTitle('Downloading Images')
            .setDescription('Starting the download process...')
            .setColor('#0099ff');

        await interaction.editReply({ embeds: [feedbackEmbed], ephemeral: true });

        await downloadImagesToLocal(userImageMap, imagesDir, interaction, feedbackEmbed);

        // Create a single zip from downloaded images
        const zipPath = await createZipFromImages(imagesDir, interaction, channel.name);

        // Cleanup the images directory after zipping
        await cleanupDirectory(imagesDir);

        feedbackEmbed
            .setTitle('Download Complete')
            .setDescription(`Images downloaded successfully. The zip file is saved at: ${zipPath}`)
            .setColor('#00FF00');

        return interaction.editReply({ embeds: [feedbackEmbed], ephemeral: true });

    } catch (error) {
        logger.error(`Error downloading images: ${error.message}`, { error });
        const errorEmbed = new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred while downloading images: ${error.message}`)
            .setColor('#FF0000');

        return interaction.editReply({ embeds: [errorEmbed], ephemeral: true });
    }
}

async function fetchMessages(channel) {
    const messages = [];
    let lastId;

    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const fetchedMessages = await channel.messages.fetch(options);
        if (fetchedMessages.size === 0) break;

        messages.push(...fetchedMessages.values());
        lastId = fetchedMessages.last().id;
    }

    return messages;
}

function extractImageUrlsByUser(messages) {
    const userImageMap = {};

    for (const message of messages) {
        if (message.attachments.size > 0) {
            const userId = message.author.id;
            const userName = message.author.username;

            if (!userImageMap[userId]) {
                userImageMap[userId] = { userName, images: [] };
            }

            message.attachments.forEach(attachment => {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    userImageMap[userId].images.push({ url: attachment.url, name: attachment.name });
                }
            });
        }
    }

    return userImageMap;
}

async function downloadImagesToLocal(userImageMap, imagesDir, interaction, feedbackEmbed) {
    let totalImages = 0;
    for (const userId in userImageMap) {
        totalImages += userImageMap[userId].images.length;
    }

    let completedImages = 0;

    for (const userId in userImageMap) {
        const userFolder = path.join(imagesDir, `${userImageMap[userId].userName}_${userId}`);
        if (!fs.existsSync(userFolder)) {
            fs.mkdirSync(userFolder);
        }

        for (const [index, { url, name }] of userImageMap[userId].images.entries()) {
            const filePath = path.join(userFolder, name || `image${index + 1}.jpg`);
            try {
                const response = await axios.get(url, { responseType: 'stream', timeout: 10000 });
                response.data.pipe(fs.createWriteStream(filePath));
                await new Promise((resolve, reject) => {
                    response.data.on('end', resolve);
                    response.data.on('error', reject);
                });

                completedImages++;
                if (completedImages % 10 === 0 || completedImages === totalImages) {
                    feedbackEmbed.setDescription(`Downloading images... (${completedImages}/${totalImages})`);
                    await interaction.editReply({ embeds: [feedbackEmbed], ephemeral: true });
                }
                logger.info(`Downloaded ${completedImages}/${totalImages} images`);
            } catch (error) {
                logger.error(`Error downloading image from ${url}: ${error.message}`, { error });
            }
        }
    }
}

async function createZipFromImages(imagesDir, interaction, channelName) {
    const sanitizedChannelName = channelName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dateStr = DateTime.now().toFormat('yyyyMMdd_HHmmss');
    const zipFileName = `images_${sanitizedChannelName}_${dateStr}.zip`;
    const zipPath = path.join(__dirname, '../../downloads', zipFileName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    await new Promise((resolve, reject) => {
        output.on('close', () => {
            logger.info(`Zip file created successfully with ${archive.pointer()} total bytes`);
            resolve();
        });
        output.on('error', (err) => {
            logger.error(`Output stream error: ${err.message}`);
            reject(err);
        });
        archive.on('error', (err) => {
            logger.error(`Archiver error: ${err.message}`);
            reject(err);
        });
        archive.pipe(output);

        const users = fs.readdirSync(imagesDir);
        for (const user of users) {
            const userFolder = path.join(imagesDir, user);
            if (!fs.lstatSync(userFolder).isDirectory()) continue;

            const files = fs.readdirSync(userFolder);
            for (const file of files) {
                const filePath = path.join(userFolder, file);
                logger.info(`Adding ${filePath} to archive`);
                archive.file(filePath, { name: `${user}/${file}` });
            }
        }

        archive.finalize().catch(err => {
            logger.error(`Error finalizing archive: ${err.message}`);
            reject(err);
        });
    });

    const feedbackEmbed = new EmbedBuilder()
        .setTitle('Finalizing Archive')
        .setDescription('All images downloaded, finalizing archive...')
        .setColor('#0099ff');
    
    await interaction.editReply({ embeds: [feedbackEmbed], ephemeral: true });

    return zipPath;
}

async function cleanupDirectory(directoryPath) {
    fs.rm(directoryPath, { recursive: true, force: true }, (err) => {
        if (err) {
            logger.error(`Error cleaning up directory ${directoryPath}: ${err.message}`);
        } else {
            logger.info(`Successfully cleaned up directory ${directoryPath}`);
        }
    });
}

module.exports = {
    data: commandData.toJSON(),
    execute,
};
