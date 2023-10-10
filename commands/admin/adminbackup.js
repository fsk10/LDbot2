const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { isAdmin } = require('../../utils/permissions');
const logger = require('../../utils/logger');

let backupIntervalID = null;
const backupConfigPath = path.join(__dirname, '../../config/backupConfig.js');
const databasePath = path.join(__dirname, '../../database/db.sqlite');
const backupDirectory = path.join(__dirname, '../../backup');
const initialBackupConfig = loadBackupConfig();
setBackupInterval(initialBackupConfig);


const commandData = new SlashCommandBuilder()
    .setName('adminbackup')
    .setDescription('Manage automatic backup settings.')
    .addSubcommand(subcommand => 
        subcommand.setName('status')
                  .setDescription('Shows the status of backups.'))
    .addSubcommand(subcommand =>
        subcommand.setName('enabled')
                  .setDescription('Enable or disable automatic backups.')
                  .addBooleanOption(option => 
                      option.setName('value')
                            .setDescription('Enable or Disable')
                            .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand.setName('interval')
                    .setDescription('Set the backup interval in days')
                    .addIntegerOption(option => 
                        option.setName('days')
                            .setDescription('Number of days')
                            .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand.setName('versions')
                    .setDescription('Set the number of backup versions to keep')
                    .addIntegerOption(option => 
                        option.setName('count')
                            .setDescription('Number of versions')
                            .setRequired(true)))
    .addSubcommand(subcommand => 
        subcommand.setName('force')
                    .setDescription('Force an immediate backup.'));
            

async function execute(interaction) {

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

        await interaction.deferReply({ ephemeral: true });

        const backupConfig = loadBackupConfig();
        const subcommand = interaction.options.getSubcommand();

        let replyMessage = '';

        switch (subcommand) {
            case 'status':
                try {
                    const allFiles = fs.readdirSync(backupDirectory);
                    const backupFiles = allFiles.filter(file => file.endsWith('.sqlite')).sort().reverse();
                    let latestBackupDate = 'None';
                    let totalBackups = 0;

                    if (backupFiles.length > 0) {
                        totalBackups = backupFiles.length;
                        const matches = backupFiles[0].match(/^db_backup_(\d{4}\d{2}\d{2}-\d{2}\d{2}\d{2})/
                        );
                        if (matches && matches[1]) {
                            latestBackupDate = formatBackupFilenameToReadable(backupFiles[0]);
                        } else {
                            latestBackupDate = "Unexpected filename format for backup.";
                        }
                    }

                    let nextBackupDate = "Unknown";
                    if (backupConfig.isEnabled) {
                        const now = DateTime.utc().toJSDate();
                        const nextBackupDateTime = new Date(now.getTime() + (backupConfig.intervalInDays * 24 * 60 * 60 * 1000));
                        nextBackupDate = formatDateToReadable(nextBackupDateTime);
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('Backup Status')
                        .setColor('#0099ff')
                        .addFields(
                            { name: 'Backup Enabled', value: backupConfig.isEnabled ? "Yes" : "No" },
                            { name: 'Backup Interval', value: `${backupConfig.intervalInDays} days` },
                            { name: 'Versions to Keep', value: `${backupConfig.versionsToKeep}` },
                            { name: 'Total backups', value: String(totalBackups) },
                            { name: 'Latest backup', value: latestBackupDate },
                            { name: 'Next backup', value: nextBackupDate }
                        );
                    await interaction.editReply({ embeds: [embed], ephemeral: true });

                    return;

                } catch (err) {
                    logger.error("Error fetching backup status:", err.message);

                    const errorEmbed = new EmbedBuilder()
                        .setTitle('Backup Status Error')
                        .setDescription("Error fetching backup status. Please check the logs.")
                        .setColor('#FF0000'); 

                    await interaction.editReply({ embeds: [errorEmbed], ephemeral: true });

                }
                break;

            case 'enabled':
                const isEnabled = interaction.options.getBoolean('value');
                backupConfig.isEnabled = isEnabled;
                replyMessage += `Backup is now ${isEnabled ? "enabled" : "disabled"}`;
                saveBackupConfig(backupConfig);
                setBackupInterval(backupConfig);
                break;

            case 'interval':
                const interval = interaction.options.getInteger('days');
                backupConfig.intervalInDays = interval;
                replyMessage += `Interval set to ${interval} days`;
                saveBackupConfig(backupConfig);
                setBackupInterval(backupConfig);
                break;

            case 'versions':
                const versions = interaction.options.getInteger('count');
                backupConfig.versionsToKeep = versions;
                replyMessage += `Versions to retain set to ${versions}`;
                saveBackupConfig(backupConfig);
                break;

            case 'force':
                const backupFilename = await handleBackupProcess(true);
                if (backupFilename) {
                    replyMessage += `Backup operation has been initiated.\n\n**Created Backup File:** ${backupFilename}`;
                } else {
                    replyMessage += "Backup operation has been initiated.";
                }
                break;
        }

        const embed = new EmbedBuilder()
            .setTitle('Backup Operation')
            .setDescription(replyMessage.trim())
            .setColor('#0099ff');

        await interaction.editReply({ embeds: [embed], ephemeral: true });
}          


// FUNCTIONS

function setBackupInterval(backupConfig) {
    // Clear any existing backup interval
    if (backupIntervalID) {
        clearInterval(backupIntervalID);
    }

    // If backups are enabled, set a new interval
    if (backupConfig.isEnabled) {
        backupIntervalID = setInterval(handleBackupProcess, backupConfig.intervalInDays * 24 * 60 * 60 * 1000);
    }
}

// Load backup configuration
function loadBackupConfig() {
    delete require.cache[require.resolve(backupConfigPath)]; // Clear cache to reload fresh config
    return require(backupConfigPath);
}

// Save updated backup configuration
function saveBackupConfig(config) {
    fs.writeFileSync(backupConfigPath, `module.exports = ${JSON.stringify(config, null, 4)};`);
}

function getChecksum(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        
        stream.on('data', chunk => {
            hash.update(chunk);
        });
        
        stream.on('end', () => {
            resolve(hash.digest('hex'));
        });

        stream.on('error', err => {
            reject(err);
        });
    });
}

async function handleBackupProcess(force = false) {
    try {
        // Ensure the backup directory exists
        if (!fs.existsSync(backupDirectory)) {
            fs.mkdirSync(backupDirectory);
        }

        if (force) {
            const backupFilename = await createForcedBackup();
            return backupFilename;
        }

        // Compute the checksum of the current database file
        const currentChecksum = await getChecksum(databasePath);

        // Get the list of existing backup files and filter out only valid backup files
        const backupFiles = fs.readdirSync(backupDirectory)
            .filter(file => /^db_backup_\d{8}-\d{6}\.sqlite$/.test(file))
            .sort()
            .reverse();

        // If there are existing backups, compute the checksum of the most recent backup
        let lastBackupChecksum = "";
        if (backupFiles.length > 0) {
            lastBackupChecksum = await getChecksum(path.join(backupDirectory, backupFiles[0]));
        }

        // If the checksums are different, or there are no existing backups, create a new backup
        if (currentChecksum !== lastBackupChecksum || backupFiles.length === 0) {
            const backupFilename = generateBackupFilename();
            const backupPath = path.join(backupDirectory, backupFilename);

            // Copies the current database to the backup directory with a new timestamped name
            fs.copyFileSync(databasePath, backupPath);
        }

        // Retention logic
        ensureBackupRetention();
        
    } catch (error) {
        logger.error("Error during backup process:", error);
    }
}

async function createForcedBackup() {
    // Load backup configuration
    const backupConfig = loadBackupConfig();

    // Create new backup
    const backupFilename = generateBackupFilename();
    const backupPath = path.join(backupDirectory, backupFilename);
    fs.copyFileSync(databasePath, backupPath);

    // Retention logic
    ensureBackupRetention();
    
    return backupFilename;
}

function formatDateToReadable(dateTime) {
    const dt = DateTime.fromJSDate(dateTime).setZone('Europe/Stockholm');
    return dt.toFormat('yyyy-MM-dd HH:mm:ss');
}

function generateBackupFilename() {
    const now = DateTime.now().setZone('Europe/Stockholm').toFormat('yyyyMMdd-HHmmss');
    return `db_backup_${now}.sqlite`;
}

function formatBackupFilenameToReadable(filename) {
    const matches = filename.match(/^db_backup_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (matches && matches.length === 7) {
        return `${matches[1]}-${matches[2]}-${matches[3]} ${matches[4]}:${matches[5]}:${matches[6]}`;
    }
    return filename; // Return original filename if it doesn't match the expected format
}

function ensureBackupRetention() {
    const backupConfig = loadBackupConfig();

    const backupFiles = fs.readdirSync(backupDirectory)
        .filter(file => /^db_backup_\d{8}-\d{6}\.sqlite$/.test(file))
        .sort();

    while (backupFiles.length > backupConfig.versionsToKeep) {
        const oldestBackup = backupFiles.shift();
        fs.unlinkSync(path.join(backupDirectory, oldestBackup));
    }
}


module.exports = {
    data: commandData.toJSON(),
    execute
};
