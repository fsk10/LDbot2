const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { ChannelType } = require('discord.js');
const { sequelize } = require('../database/database');
const emailValidator = require("email-validator");
const { TemporaryRegistration, UserModel, EventModel, EventUsersModel } = require('../models');
const countries = require('../config/countryList');
const { assignSeat, isNicknameAvailable } = require('../database/operations.js');
const { loadChartById } = require('../utils/seating');
const logger = require('../utils/logger');
const { flagOrDash, countryFlag, buildAccountDetailsConfirmEmbed } = require('../utils/embeds');
const { getRegistrationSnapshot } = require('../utils/registrationData');
const { withEventLock } = require('../utils/eventLock');
const { getHeldSeats, SEAT_HOLD_MINUTES } = require('../utils/seatHolds');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        if (message.author.bot || message.channel.type !== ChannelType.DM) return; 
        
        const tempReg = await TemporaryRegistration.findOne({ where: { discorduser: message.author.id } });

        // Cancellation logic begins
        if (['!cancel', '!abort'].includes(message.content.toLowerCase())) {
            // Check if the user has an ongoing registration
            if (tempReg) {
                await tempReg.destroy();  // Delete their temporary registration from the database
            }

            const regAbortEmbed = new EmbedBuilder()
                .setTitle('Aborted')
                .setDescription('Your registration has been aborted!')
                .setColor('#DD3601');
            await message.author.send({ embeds: [regAbortEmbed] });
            return;
        }

        if (!tempReg) {
            return;
        }    

        if (message.channel.type === ChannelType.DM) {
            if (tempReg.stage === 'showingConfirmation') {
                return await message.author.send("Please use the provided buttons to continue with the registration. If you want to cancel the registration, click the 'Cancel' button.");
            }            
            
            if (tempReg && tempReg.stage) {
                switch (tempReg.stage) {
                    case 'collectingNickname':
                        // Use the isNicknameAvailable function to validate the nickname
                        const isNicknameValid = await isNicknameAvailable(message.author.id, message.content);
                        
                        if (!isNicknameValid) {
                            const regNicknameTakenEmbed = new EmbedBuilder()
                                .setTitle('Nickname Taken')
                                .setDescription('This nickname is already taken or in the process of being registered. Please choose a different nickname.')
                                .setColor('#DD3601');
                            await message.author.send({ embeds: [regNicknameTakenEmbed] });
                            return;
                        }

                        const forbiddenChars = /[`*_~|]/;
                        if (forbiddenChars.test(message.content)) {
                            const embed = new EmbedBuilder()
                                .setTitle('Invalid nickname')
                                .setDescription('Your nickname contains characters that are not allowed: `` ` * _ ~ | ``\nPlease type your nickname again without these characters.')
                                .setColor('#DD3601');
                            await message.author.send({ embeds: [embed] });
                            return;
                        }

                        tempReg.nickname = message.content;
                        tempReg.stage = 'collectingFirstname';
                        try {
                            await tempReg.save();
                        } catch (error) {
                            await message.author.send("An error occurred. Please try again later.");
                            return;
                        }                        
                        const regFirstnameEmbed = new EmbedBuilder()
                            .setTitle('Firstname')
                            .setDescription('Please provide your firstname.')
                            .setColor('#0089E4');
                        await message.author.send({ embeds: [regFirstnameEmbed] });
                        break;

                    case 'collectingFirstname':
                        tempReg.firstname = message.content;
                        tempReg.stage = 'collectingLastname';
                        try {
                            await tempReg.save();
                        } catch (error) {
                            await message.author.send("An error occurred. Please try again later.");
                            return;
                        } 
                        const regLasttnameEmbed = new EmbedBuilder()
                            .setTitle('Lastname')
                            .setDescription('Please provide your lastname.')
                            .setColor('#0089E4');
                        await message.author.send({ embeds: [regLasttnameEmbed] });
                        break;

                    case 'collectingLastname':
                        tempReg.lastname = message.content;
                        tempReg.stage = 'collectingEmail';
                        try {
                            await tempReg.save();
                        } catch (error) {
                            await message.author.send("An error occurred. Please try again later.");
                            return;
                        } 
                        const regEmailEmbed = new EmbedBuilder()
                            .setTitle('E-mail address')
                            .setDescription('Please provide your e-mail address.')
                            .setColor('#0089E4');
                        await message.author.send({ embeds: [regEmailEmbed] });
                        break;

                    case 'collectingEmail':
                        if (!emailValidator.validate(message.content)) {                           
                            const regEmailInvalidEmbed = new EmbedBuilder()
                                .setTitle('Invalid E-mail Format')
                                .setDescription('You have entered an email-address in an invalid format. Please provide a valid email.')
                                .setColor('#DD3601');
                            await message.author.send({ embeds: [regEmailInvalidEmbed] });
                            return;
                        }
                        tempReg.email = message.content;
                        tempReg.stage = 'collectingCountry';
                        try {
                            await tempReg.save();
                        } catch (error) {
                            await message.author.send("An error occurred. Please try again later.");
                            return;
                        } 
                        const regCountryEmbed = new EmbedBuilder()
                            .setTitle('Country')
                            .setDescription('Please provide your country of residence.\n\nUse a two letter country code [alpha-2-code] \nhttps://www.iban.com/country-codes')
                            .setColor('#0089E4');
                        await message.author.send({ embeds: [regCountryEmbed] });
                        break;

                    case 'collectingCountry':
                        const providedCountryCode = message.content.toUpperCase();
                        const country = countries.find(c => c.value === providedCountryCode);
                        
                        if (country) {
                            tempReg.unconfirmedCountry = providedCountryCode; // Store temporarily
                            tempReg.stage = 'confirmingCountry';
                            try {
                                await tempReg.save();
                            } catch (error) {
                                await message.author.send("An error occurred. Please try again later.");
                                return;
                            }

                            const row = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId('country_yes')
                                        .setLabel('Yes')
                                        .setStyle('1'),
                                    new ButtonBuilder()
                                        .setCustomId('country_no')
                                        .setLabel('No')
                                        .setStyle('4')
                                );

                                const regCountryConfirmEmbed = new EmbedBuilder()
                                    .setTitle(`You've selected ${[countryFlag(country.value), `__${country.name}__`].filter(Boolean).join(' ')}. Is this correct?`)
                                    .setColor('#0089E4');
                                
                                await message.author.send({ 
                                    embeds: [regCountryConfirmEmbed],
                                    components: [row]
                                });

                        } else {
                            await message.author.send(`The country-code ${providedCountryCode} is incorrect or not available in my list. Please try again or reply with 'NULL' to set a blank value.`);

                            const regCountryInvalidEmbed = new EmbedBuilder()
                                .setTitle('Invalid Country-code')
                                .setDescription(`The country-code ${providedCountryCode} is incorrect or not available in my list. Please try again or reply with 'NULL' to set a blank value.`)
                                .setColor('#DD3601');
                            await message.author.send({ embeds: [regCountryInvalidEmbed] });
                        }
                        break;

                    case 'confirmingCountry':
                        if (message.content.toLowerCase() === 'null') {
                            // Apply a blank country
                            tempReg.unconfirmedCountry = null;
                            tempReg.country = null;

                            // If we're editing account only, DO NOT go to seat selection.
                            if (tempReg.editMode === 'accountOnly') {
                            tempReg.stage = 'showingAccountConfirm';
                            try { await tempReg.save(); } catch (error) {
                                await message.author.send("An error occurred. Please try again later.");
                                break;
                            }

                            const snap = await getRegistrationSnapshot(message.author.id);
                            const eventRow = await EventModel.findByPk(tempReg.eventId);

                            const confirmEmbed = buildAccountDetailsConfirmEmbed({
                                eventName: eventRow?.name || 'this event',
                                snap,
                                discordUsername: message.author.username,
                            });

                            const row = new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId('registration_continue').setLabel('Confirm').setStyle(3),
                                new ButtonBuilder().setCustomId('registration_cancel').setLabel('Cancel').setStyle(4),
                            );

                            await message.author.send({ embeds: [confirmEmbed], components: [row] });
                            break;
                            }

                            // Normal (not account-only): proceed to seat selection
                            tempReg.stage = 'collectingPreferredSeats';
                            try { await tempReg.save(); } catch (error) {
                            await message.author.send("An error occurred. Please try again later.");
                            break;
                            }

                            const regPrefSeatsEmbed = new EmbedBuilder()
                            .setTitle('Preferred Seats')
                            .setDescription('Please provide your preferred seats for the event.\nFormated as a comma-separated list e.g. 3,11,29,...')
                            .setColor('#0089E4');
                            await message.author.send({ embeds: [regPrefSeatsEmbed] });
                        } else {
                            await message.author.send(`Please respond using the provided buttons or type 'null' if you wish to set a blank country code.`);
                        }
                        break;


                    case 'collectingPreferredSeats':
                        if (tempReg.editMode === 'accountOnly') {
                            await message.author.send('You are editing account details only. Please use the Confirm/Cancel buttons I sent.');
                            break;
                        }

                        const raw = (message.content || '').trim();

                        // Accept seat labels like "A-01, A-02"; keep original strings
                        const preferred = raw
                        .split(',')
                        .map(s => s.trim())
                        .filter(s => s.length > 0);

                        if (preferred.length === 0) {
                            const warn = new EmbedBuilder()
                            .setTitle('No seats detected')
                            .setDescription('Please provide your preferred seats as a comma-separated list, e.g. `3,11,29`.')
                            .setColor('#DD3601');
                            await message.author.send({ embeds: [warn] });
                            break;
                        }

                        // Validate that seats exist in the seating chart
                        try {
                            const event = await EventModel.findByPk(tempReg.eventId);
                            const chartId = event?.chartId || 'default';
                            const { chart } = await loadChartById(chartId);
                            const validSeatIds = new Set(chart.seats.map(s => String(s.id)));
                            const nonExistentSeats = preferred.filter(s => !validSeatIds.has(s));
                            if (nonExistentSeats.length > 0) {
                                const warn = new EmbedBuilder()
                                .setTitle('Seats not found')
                                .setDescription(`The following seat(s) do not exist in the seating chart: \`${nonExistentSeats.join(', ')}\`\nPlease check the seating map and try again.`)
                                .setColor('#DD3601');
                                await message.author.send({ embeds: [warn] });
                                break;
                            }
                        } catch (e) {
                            logger.warn('Could not validate seats against chart:', e.message);
                        }

                        // Pick the first seat that is neither taken nor held by someone
                        // else mid-registration, and save it (= hold it) under the
                        // event lock so two users can't grab the same seat at once.
                        let picked = null;
                        await withEventLock(tempReg.eventId, async () => {
                            const held = await getHeldSeats(tempReg.eventId, message.author.id);
                            for (const seat of preferred) {
                                if (held.has(String(seat))) continue;
                                const taken = await EventUsersModel.findOne({
                                where: { eventId: tempReg.eventId, seat }
                                });
                                if (!taken) { picked = seat; break; }
                            }
                            if (picked) {
                                tempReg.seat = picked;
                                tempReg.stage = 'showingConfirmation';
                                await tempReg.save();
                            }
                        });

                        if (!picked) {
                            const allTaken = new EmbedBuilder()
                            .setTitle('Seats unavailable')
                            .setDescription(
                                'All of your preferred seats are taken or being held by someone who is registering right now.\n' +
                                'Please send a new list, e.g. `7,8,15`.'
                            )
                            .setColor('#DD3601');
                            await message.author.send({ embeds: [allTaken] });
                            break;
                        }

                        try {
                            const user = await UserModel.findOne({ where: { discorduser: message.author.id } });
                            if (user && tempReg.eventId) {
                                const exists = await EventUsersModel.findOne({
                                where: { userId: user.id, eventId: tempReg.eventId },
                                });
                                if (exists) tempReg.editingExisting = true;
                            }
                        } catch (e) {
                            logger.warn('Could not check if user is editing existing registration:', e.message);
                        }

                        // Build a proper confirmation embed with buttons (use snapshot so fields aren’t blank)
                        const event = await EventModel.findByPk(tempReg.eventId);
                        const snap  = await getRegistrationSnapshot(message.author.id);

                        const confirm = new EmbedBuilder()
                        .setTitle('Registration Confirmation')
                        .setDescription(`Please review your registration details again and confirm.\nYour seat is held for you for **${SEAT_HOLD_MINUTES} minutes**.`)
                        .setColor('#28B81C')
                        .addFields(
                            { name: '📍 Event', value: event?.name || String(tempReg.event || tempReg.eventId), inline: false },
                            { name: '👾 Nickname', value: snap.nickname || '—', inline: true },
                            { name: '👤 Discord User', value: message.author.username || '—', inline: true },
                            { name: '🗺️ Country', value: flagOrDash(snap.country), inline: true },
                            { name: '☝️ Firstname', value: snap.firstname || '—', inline: true },
                            { name: '✌️ Lastname', value: snap.lastname || '—', inline: true },
                            { name: '📧 Email', value: snap.email || '—', inline: true },
                            { name: '🪑 Seat', value: `#${picked}`, inline: true },
                        );

                        const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('registration_continue').setLabel('Confirm').setStyle(3),
                        new ButtonBuilder().setCustomId('registration_edit').setLabel('Edit responses').setStyle(1),
                        new ButtonBuilder().setCustomId('registration_cancel').setLabel('Cancel').setStyle(4)
                        );

                        await message.author.send({ embeds: [confirm], components: [row] });

                        break;
                                     
                    
                    case 'editingExistingRegistration':
                        await message.author.send("Please use the buttons provided in the previous message to manage your registration.");
                        break;                                        

                    default:
                        await message.author.send("Please use the provided buttons to continue with the registration. If you want to cancel the registration, click the 'Cancel' button.");
                        break;
                }
            }
        }
    }
};
