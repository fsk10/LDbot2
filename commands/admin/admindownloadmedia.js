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
    .setName('admindownloadmedia')
    .setDescription('Download all images and videos from a specified channel')
    .addChannelOption(option => 
        option.setName('channel')
            .setDescription('The channel to download images and videos from')
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
    logger.info(`Channel ID: ${channel.id}, Channel Type: ${channel.type}`);

    if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'Please provide a valid text channel.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const messages = await fetchMessages(channel);
        const userMediaMap = extractMediaUrlsByUser(messages);

        if (Object.keys(userMediaMap).length === 0) {
            return interaction.editReply({ content: 'No images or videos found in the specified channel.', ephemeral: true });
        }

        // Download media to local filesystem first
        const mediaDir = path.join(__dirname, '../../downloads/media');
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir, { recursive: true });
        }

        const feedbackEmbed = new EmbedBuilder()
            .setTitle('Downloading Media [1/3]')
            .setDescription('Starting the download process...')
            .setColor('#0099ff');

        await interaction.editReply({ embeds: [feedbackEmbed], ephemeral: true });

        await downloadMediaToLocal(userMediaMap, mediaDir, interaction, feedbackEmbed);

        // Update feedback message to indicate zipping has started
        feedbackEmbed
            .setTitle('Creating Archive [2/3]')
            .setDescription('All media downloaded. Starting to create the zip archive.')
            .setColor('#0099ff');
        await interaction.editReply({ embeds: [feedbackEmbed], ephemeral: true });

        // Create a single zip from downloaded media
        const zipPath = await createZipFromMedia(mediaDir, interaction, channel.name);

        // Cleanup the media directory after zipping
        await cleanupDirectory(mediaDir);

        feedbackEmbed
            .setTitle('Download Complete [3/3]')
            .setDescription(`Media downloaded successfully.\n\nThe zip file is saved at:\n${zipPath}`)
            .setColor('#00FF00');

        return interaction.editReply({ embeds: [feedbackEmbed], ephemeral: true });

    } catch (error) {
        logger.error(`Error downloading media: ${error.message}`, { error });
        const errorEmbed = new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred while downloading media: ${error.message}`)
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

function extractMediaUrlsByUser(messages) {
    const userMediaMap = {};

    for (const message of messages) {
        if (message.attachments.size > 0) {
            const userId = message.author.id;
            const userName = message.author.username;

            if (!userMediaMap[userId]) {
                userMediaMap[userId] = { userName, media: [] };
            }

            message.attachments.forEach(attachment => {
                if (attachment.contentType && (attachment.contentType.startsWith('image/') || attachment.contentType.startsWith('video/'))) {
                    userMediaMap[userId].media.push({ url: attachment.url, name: attachment.name });
                }
            });
        }
    }

    return userMediaMap;
}

async function downloadMediaToLocal(userMediaMap, mediaDir, interaction, feedbackEmbed) {
    let totalMedia = 0;
    for (const userId in userMediaMap) {
        totalMedia += userMediaMap[userId].media.length;
    }

    let completedMedia = 0;

    for (const userId in userMediaMap) {
        const userFolder = path.join(mediaDir, `${userMediaMap[userId].userName}_${userId}`);
        if (!fs.existsSync(userFolder)) {
            fs.mkdirSync(userFolder);
        }

        for (const [index, { url, name }] of userMediaMap[userId].media.entries()) {
            const filePath = path.join(userFolder, name || `media${index + 1}`);
            try {
                const response = await axios.get(url, { responseType: 'stream', timeout: 10000 });
                response.data.pipe(fs.createWriteStream(filePath));
                await new Promise((resolve, reject) => {
                    response.data.on('end', resolve);
                    response.data.on('error', reject);
                });

                completedMedia++;
                if (completedMedia % 10 === 0 || completedMedia === totalMedia) {
                    feedbackEmbed.setDescription(`Downloading media... (${completedMedia}/${totalMedia})`);
                    await interaction.editReply({ embeds: [feedbackEmbed], ephemeral: true });
                }
                logger.info(`Downloaded media file ${completedMedia}/${totalMedia}`);
            } catch (error) {
                logger.error(`Error downloading media from ${url}: ${error.message}`, { error });
            }
        }
    }
}

async function createZipFromMedia(mediaDir, interaction, channelName) {
    const sanitizedChannelName = channelName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dateStr = DateTime.now().toFormat('yyyyMMdd_HHmmss');
    const zipFileName = `media_${sanitizedChannelName}_${dateStr}.zip`;
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

        const users = fs.readdirSync(mediaDir);
        for (const user of users) {
            const userFolder = path.join(mediaDir, user);
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
        .setDescription('All media downloaded, finalizing archive...')
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
