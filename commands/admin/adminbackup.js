const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { isAdmin } = require('../../utils/permissions');
const logger = require('../../utils/logger');

let backupIntervalID = null;
const databasePath = path.join(__dirname, '../../database/db.sqlite');
const chartsDirectory = path.join(__dirname, '../../charts');
const backupConfigPath = path.join(__dirname, '../../config/backupConfig.js');
const backupDirectory = path.join(__dirname, '../../backup');
const checksumFile = path.join(backupDirectory, '.last_backup_checksum');
const defaultBackupConfig = {
    isEnabled: false,
    intervalInDays: 7, // default to 7 days, for example
    versionsToKeep: 5, // default to 5 versions, for example
    backupStartTime: null
};
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
                    const backupFiles = allFiles.filter(file => /^backup_\d{8}-\d{6}\.zip$/.test(file)).sort().reverse();
                    let lastBackupDate = 'None';
                    let totalBackups = 0;

                    if (backupFiles.length > 0) {
                        totalBackups = backupFiles.length;
                        const matches = backupFiles[0].match(/^backup_(\d{4}\d{2}\d{2}-\d{2}\d{2}\d{2})/);
                        if (matches && matches[1]) {
                            lastBackupDate = formatBackupFilenameToReadable(backupFiles[0]);
                        } else {
                            lastBackupDate = "Unexpected filename format for backup.";
                        }
                    }

                    let nextBackupDate = "Unknown";
                    if (backupConfig.isEnabled && backupConfig.backupStartTime) {
                        const backupStartTime = DateTime.fromISO(backupConfig.backupStartTime);
                        const intervalsPassed = Math.ceil((DateTime.utc().diff(backupStartTime, 'days').days) / backupConfig.intervalInDays);
                        const nextBackupDateTime = backupStartTime.plus({ days: intervalsPassed * backupConfig.intervalInDays });
                        nextBackupDate = formatDateToReadable(nextBackupDateTime.toJSDate());
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('Backup Status')
                        .setColor('#0099ff')
                        .addFields(
                            { name: 'Backup Enabled', value: backupConfig.isEnabled ? "Yes" : "No" },
                            { name: 'Backup Interval', value: `${backupConfig.intervalInDays} days` },
                            { name: 'Versions to Keep', value: `${backupConfig.versionsToKeep}` },
                            { name: 'Total backups', value: String(totalBackups) },
                            { name: 'Last backup', value: lastBackupDate },
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

                if (isEnabled && !backupConfig.backupStartTime) {
                    backupConfig.backupStartTime = DateTime.utc().toISO();  // Store current time as backup start time
                    saveBackupConfig(backupConfig);
                }                

                replyMessage += `Automatic backup is now ${isEnabled ? "enabled" : "disabled"}`;
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
    if (!fs.existsSync(backupConfigPath)) {
        saveBackupConfig(defaultBackupConfig);
    }

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

        // Compare with last stored checksum
        let lastBackupChecksum = '';
        if (fs.existsSync(checksumFile)) {
            lastBackupChecksum = fs.readFileSync(checksumFile, 'utf8').trim();
        }

        const backupFiles = fs.readdirSync(backupDirectory)
            .filter(file => /^backup_\d{8}-\d{6}\.zip$/.test(file));

        // If the checksums are different, or there are no existing backups, create a new backup
        if (currentChecksum !== lastBackupChecksum || backupFiles.length === 0) {
            const backupFilename = generateBackupFilename();
            const backupPath = path.join(backupDirectory, backupFilename);
            await createZipBackup(backupPath);
            fs.writeFileSync(checksumFile, currentChecksum);
        }

        // Retention logic
        ensureBackupRetention();

    } catch (error) {
        logger.error("Error during backup process:", error);
    }
}

async function createForcedBackup() {
    const backupFilename = generateBackupFilename();
    const backupPath = path.join(backupDirectory, backupFilename);
    await createZipBackup(backupPath);

    const currentChecksum = await getChecksum(databasePath);
    fs.writeFileSync(checksumFile, currentChecksum);

    // Retention logic
    ensureBackupRetention();

    return backupFilename;
}

function createZipBackup(backupPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(backupPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', resolve);
        archive.on('error', reject);

        archive.pipe(output);
        archive.file(databasePath, { name: 'db.sqlite' });

        if (fs.existsSync(chartsDirectory)) {
            archive.directory(chartsDirectory, 'charts');
        }

        archive.finalize();
    });
}

function formatDateToReadable(dateTime) {
    const dt = DateTime.fromJSDate(dateTime).setZone('Europe/Stockholm');
    return dt.toFormat('yyyy-MM-dd HH:mm:ss');
}

function generateBackupFilename() {
    const now = DateTime.now().setZone('Europe/Stockholm').toFormat('yyyyMMdd-HHmmss');
    return `backup_${now}.zip`;
}

function formatBackupFilenameToReadable(filename) {
    const matches = filename.match(/^backup_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (matches && matches.length === 7) {
        return `${matches[1]}-${matches[2]}-${matches[3]} ${matches[4]}:${matches[5]}:${matches[6]}`;
    }
    return filename;
}

function ensureBackupRetention() {
    const backupConfig = loadBackupConfig();

    const backupFiles = fs.readdirSync(backupDirectory)
        .filter(file => /^backup_\d{8}-\d{6}\.zip$/.test(file))
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
