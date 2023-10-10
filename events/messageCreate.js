const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { ChannelType } = require('discord.js');
const { sequelize } = require('../database/database');
const emailValidator = require("email-validator");
const { TemporaryRegistration, UserModel, EventModel } = require('../models');
const countries = require('../config/countryList');
const { assignSeat, isNicknameAvailable } = require('../database/operations.js');
const logger = require('../utils/logger');

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
            logger.error(`The ID ${message.author.id} does not exist in TemporaryRegistration.`);
            return;
        }    

        if (message.channel.type === ChannelType.DM) {
            if (tempReg.stage === 'showingConfirmation') {
                return await message.author.send("Please use the provided buttons to continue with the registration. If you want to cancel the registration, click the 'Cancel' button.");
            }            
            
            if (tempReg && tempReg.stage) {
                switch (tempReg.stage) {
                    case 'collectingNickname':
                        // logger.info("Handling collectingNickname stage");

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

                        tempReg.nickname = message.content;
                        tempReg.stage = 'collectingFirstname';
                        try {
                            await tempReg.save();
                        } catch (error) {
                            logger.error("Error saving Temporary Registration:", error.message);
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
                        // logger.info("Handling collectingFirstname stage");
                        tempReg.firstname = message.content;
                        tempReg.stage = 'collectingLastname';
                        try {
                            await tempReg.save();
                        } catch (error) {
                            logger.error("Error saving Temporary Registration:", error.message);
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
                        // logger.info("Handling collectingLastname stage");
                        tempReg.lastname = message.content;
                        tempReg.stage = 'collectingEmail';
                        try {
                            await tempReg.save();
                        } catch (error) {
                            logger.error("Error saving Temporary Registration:", error.message);
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
                        // logger.info("Handling collectingEmail stage");
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
                            logger.error("Error saving Temporary Registration:", error.message);
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
                        // logger.info("Handling collectingCountry stage");
                        const providedCountryCode = message.content.toUpperCase();
                        const country = countries.find(c => c.value === providedCountryCode);
                        
                        if (country) {
                            tempReg.unconfirmedCountry = providedCountryCode; // Store temporarily
                            tempReg.stage = 'confirmingCountry';
                            try {
                                await tempReg.save();
                            } catch (error) {
                                logger.error("Error saving Temporary Registration:", error.message);
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
                                    .setTitle(`You've selected __${country.name}__. Is this correct?`)
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
                        // logger.info("Handling collectingCountryConfirm stage");

                        if (message.content.toLowerCase() === 'null') {
                            tempReg.unconfirmedCountry = null;
                            tempReg.country = null;

                            // Move to the next registration stage.
                            tempReg.stage = 'collectingPreferredSeats';
                        
                            try {
                                await tempReg.save();  // Saving the stage change.
                            } catch (error) {
                                logger.error("Error saving Temporary Registration:", error.message);
                                await message.author.send("An error occurred. Please try again later.");
                                return;
                            }
                        
                            // Notify the user of the next step.
                            const regPrefSeatsEmbed = new EmbedBuilder()
                                .setTitle('Preferred Seats')
                                .setDescription('Please provide your preferred seats for the event.\nFormated as a comma-separated list e.g. 3,11,29,...')
                                .setColor('#0089E4');
                            await message.author.send({ embeds: [regPrefSeatsEmbed] });
                        }
                         else {
                            // If the message is not 'null' and not a button interaction (which is handled elsewhere), inform the user.
                            await message.author.send(`Please respond using the provided buttons or type 'null' if you wish to set a blank country code.`);
                        }
                        break;

                    case 'collectingPreferredSeats':
                        // ("Handling collectingPreferredSeats stage");
                   
                        // Fetch the event details to get the maximum seats
                        const event = await EventModel.findOne({ where: { id: tempReg.eventId } });
                        const eventExists = !!event;
                    
                        if (!eventExists) {
                            logger.error(`Invalid eventId: ${tempReg.eventId}`);
                            // You can send a message to the user or take other actions here.
                            return;
                        } 
                    
                        const seatsAvailable = event.seatsavailable; 
                    
                        // Filter out seat numbers that exceed the maximum
                        const preferredSeats = message.content.split(',')
                            .map(seat => parseInt(seat.trim()))
                            .filter(seat => seat <= seatsAvailable);
                    
                        // If no valid seats remain after filtering
                        if (preferredSeats.length === 0) {
                            const regPrefSeatsInvalidMaxEmbed = new EmbedBuilder()
                                .setTitle('Invalid Preferred Seats List')
                                .setDescription(`All the seat numbers you provided exceed the maximum seat number of ${seatsAvailable}. Please provide a valid list of preferred seats.`)
                                .setColor('#DD3601');
                            await message.author.send({ embeds: [regPrefSeatsInvalidMaxEmbed] });

                            return;
                        }                 

                        // Check each preferred seat for availability
                        let availableSeat;

                        try {
                            await sequelize.transaction(async (t) => {
                                availableSeat = await assignSeat(message.author.id, tempReg.eventId, preferredSeats);
                                
                                if (availableSeat) {
                                    tempReg.seat = availableSeat;
                                    await tempReg.save({ transaction: t });
                                }
                            });
                        } catch (error) {
                            logger.error("Error in assigning seat:", error);
                            await message.author.send("An error occurred while processing your seats. Please try again later.");
                            return;
                        }
                    
                        if (availableSeat) {
                            tempReg.seat = availableSeat;
                    
                            // Create the embed
                            const registrationEmbed = new EmbedBuilder()
                                .setTitle('Registration Confirmation')
                                .setColor('#FFA500')
                                .setDescription('You are registering the following information.\nConfirm your registration by clicking on **Continue**.')
                                .addFields(
                                    { name: 'Nickname', value: tempReg.nickname },
                                    { name: 'Firstname', value: tempReg.firstname },
                                    { name: 'Lastname', value: tempReg.lastname },
                                    { name: 'Email', value: tempReg.email },
                                    { name: 'Country', value: `:flag_${tempReg.country.toLowerCase()}:` },
                                    { name: 'Assigned Seat', value: tempReg.seat ? tempReg.seat.toString() : 'Not Assigned' }
                                )
                                .setFooter({ text: 'Please ensure all details are correct.' });
                    
                            // Create buttons
                            const row = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId('registration_cancel')
                                        .setLabel('Cancel')
                                        .setStyle(4),
                                    new ButtonBuilder()
                                        .setCustomId('registration_edit')
                                        .setLabel('Edit responses')
                                        .setStyle(1),
                                    new ButtonBuilder()
                                        .setCustomId('registration_continue')
                                        .setLabel('Continue')
                                        .setStyle(3)
                                );
                    
                            tempReg.stage = 'showingConfirmation';
                    
                            // Send the embed
                            await message.author.send({ embeds: [registrationEmbed], components: [row] });
                        } else {
                            await message.author.send("All preferred seats are taken. Please provide a different list of preferred seats.");
                        }
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
