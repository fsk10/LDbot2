const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ChannelType } = require('discord.js');
const { Sequelize } = require('sequelize');
const path = require('path');
const fs = require('fs');
const chartsCfg = require('../config/charts.config.json');
const { isAdmin, isEventAdminForEvent } = require('../utils/permissions');
const { listEvents, listUsers, listEventsForUser, generateCurrentSeatingMap, getAvailableSeatsForEvent, scheduleParticipantListUpdate } = require('../database/operations');
const { UserModel, EventModel, EventUsersModel, TemporaryRegistration } = require('../models');
const { buildPaymentFields, getPaymentConfigForEvent } = require('../utils/payment');
const logger = require('../utils/logger');
const { formatEventUserLog, formatEventUserDiffLog } = require('../utils/activityFormat');
const countries = require('../config/countryList');
const logActivity = require('../utils/logActivity');
const formatDisplayDate = require('../utils/dateUtils');
const { getRegistrationSnapshot } = require('../utils/registrationData');
const { getNameFromID } = require('../utils/getNameFromID');
const {
  buildReserveConfirmEmbed,
  buildReserveResultEmbed,
  buildAccountExistsEmbed,
  buildSeatPromptEmbed,
  buildSeatingMapErrorEmbed,
  buildRegistrationSubmittedEmbed,
  buildNoOngoingRegEmbed,
  buildAlreadyRegisteredEmbed,
  buildRegistrationCancelledEmbed,
  buildRegistrationFailedEmbed,
  buildCheckDMsEmbed,
  buildNoChangesUpdateEmbed,
  buildRegistrationRemovedEmbed,
  buildRegistrationStillActiveEmbed,
  buildCurrentRegistrationEmbed,
  buildManageRegistrationButtons,
  buildEditChoiceEmbed,
  buildEditChoiceButtons,
  buildAlreadyRegisteredNotice,
  buildAccountDetailsConfirmEmbed
} = require('../utils/embeds');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction) {

    // ---------- Slash commands ----------
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) {
        return;
      }
      try {
        await command.execute(interaction, interaction.client);
      } catch (error) {
        logger.error(`Error executing command "${interaction.commandName}":`, error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Ett fel uppstod när kommandot kördes.', ephemeral: true }).catch(() => {});
        }
      }
      return;
    }

    // ---------- Autocomplete ----------
    if (interaction.isAutocomplete()) {
      const focusedOptionName = interaction.options.getFocused(true)?.name || 'none';

      switch (interaction.commandName) {
        case 'register':
          if (focusedOptionName === 'event') await handleRegisterEventAutocomplete(interaction);
          break;

        case 'adminadd':
          if (interaction.options.getSubcommand() === 'user' && focusedOptionName === 'event') {
            await handleEventAutocomplete(interaction);
          } else if (interaction.options.getSubcommand() === 'user' && focusedOptionName === 'country') {
            await handleCountryAutocomplete(interaction);
          } else if (interaction.options.getSubcommand() === 'event') {
            if (focusedOptionName === 'paymentconfig') {
              await handlePaymentConfigAutocomplete(interaction);
            }
          } else if (interaction.options.getSubcommand() === 'eventuser') {
            if (focusedOptionName === 'event') {
              await handleEventAutocomplete(interaction);
            } else if (focusedOptionName === 'nickname') {
              await handleUserAutocomplete(interaction);
            }
          }
          break;

        case 'admindel':
          if (interaction.options.getSubcommand() === 'event' && focusedOptionName === 'eventname') {
            await handleEventAutocomplete(interaction);
          } else if (interaction.options.getSubcommand() === 'user') {
            if (focusedOptionName === 'nickname') {
              await handleUserAutocomplete(interaction);
            } else if (focusedOptionName === 'eventname') {
              await handleUserEventAutocomplete(interaction);
            }
          }
          break;

        case 'adminedit': {
          const sub = interaction.options.getSubcommand();

          if (sub === 'event') {
            if (focusedOptionName === 'eventname') {
              await handleEventAutocomplete(interaction);
            } else if (focusedOptionName === 'paymentconfig') {
              await handlePaymentConfigAutocomplete(interaction); // <-- new
            }
          } else if (sub === 'user') {
            if (focusedOptionName === 'nickname') {
              await handleUserAutocomplete(interaction);
            } else if (focusedOptionName === 'country') {
              await handleCountryAutocomplete(interaction);
            }
          } else if (sub === 'eventuser') {
            if (focusedOptionName === 'event') {
              await handleEventAutocomplete(interaction);
            } else if (focusedOptionName === 'nickname') {
              await handleEventUserNicknameAutocomplete(interaction);
            }
          }
          break;
        }

        case 'adminlist':
          if (interaction.options.getSubcommand() === 'users' && focusedOptionName === 'event') {
            await handleEventAutocomplete(interaction);
          }
          break;

        case 'adminannounce':
          if (focusedOptionName === 'event') {
            await handleEventAutocomplete(interaction);
          }
          break;

        case 'adminchart': {
          const sub = interaction.options.getSubcommand(false);
          if (sub === 'import' || sub === 'set' || sub === 'preview') {
            if (focusedOptionName === 'event') {
              await handleEventAutocomplete(interaction);
            } else if (focusedOptionName === 'chart_id' && sub === 'set') {
              await handleChartIdAutocomplete(interaction);
            }
          }
          break;
        }

        case 'eventadmin': {
          const sub = interaction.options.getSubcommand();
          const focused = interaction.options.getFocused(true)?.name;
          if (focused === 'event') {
            await handleEventAutocompleteForEventAdmin(interaction);
          } else if (focused === 'nickname') {
            await handleEventUserNicknameAutocomplete(interaction);
          }
          break;
        }

        case 'unregister':
          if (focusedOptionName === 'event') {
            await handleUnregisterAutocomplete(interaction);
          }
          break;
      }
      return;
    }

    // ---------- Buttons ----------
    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const customId = interaction.customId;

      // A) NEW PATH — explicit confirm with event id: "registration_confirm-<eventId>"
      if (customId.startsWith('registration_confirm-')) {
        const [, rawEventId] = customId.split('-');
        const eventId = parseInt(rawEventId, 10);

        try {
          const user = await UserModel.findOne({ where: { discorduser: userId } });
          if (!user) {
            const emb = buildRegistrationFailedEmbed('Could not find your user record. Please run **/register** again.');
            await interaction.reply({ embeds: [emb], ephemeral: true });
            return;
          }

          const event = await EventModel.findByPk(eventId);
          if (!event) {
            const emb = buildRegistrationFailedEmbed('That event no longer exists. Please start again.');
            await interaction.reply({ embeds: [emb], ephemeral: true });
            return;
          }

          if (!event.regopen) {
            const bypass = await canBypassRegistrationLock(interaction, event.id);
            if (!bypass) {
              const msg = 'Registration is currently closed for this event.';
              if (interaction.inGuild?.()) {
                await interaction.reply({ content: msg, ephemeral: true }).catch(()=>{});
              } else {
                try { await interaction.deferUpdate(); } catch {}
              }
              return;
            }
          }          

          // Already registered?
        const existing = await EventUsersModel.findOne({ where: { userId: user.id, eventId } });
        if (existing) {
            let participantMention = channelMentionFromRaw(event.participantchannel);

            // If we’re in a guild and didn’t parse a mention, try resolving via getNameFromID
            if (!participantMention && interaction.inGuild() && event.participantchannel) {
                try {
                const resolved = await getNameFromID(interaction, event.participantchannel);
                if (resolved?.type === 'channel') participantMention = resolved.name; // already <#id>
                } catch {}
            }

            // --- Ephemeral notice in channel
            const emb = buildAlreadyRegisteredEmbed({
                eventName: event.name,
                participantMention,
            });
            await interaction.reply({ embeds: [emb], ephemeral: true });

            // --- DM with current registration details
            try {
                const snap = await getRegistrationSnapshot(userId);
                const dmEmbed = buildCurrentRegistrationEmbed({
                eventName: event.name,
                discordUsername: interaction.user.username,
                userSnap: snap,
                seat: existing.seat || null,
                isReserve: !!existing.reserve,
                });
                const dmButtons = buildManageRegistrationButtons();

                await interaction.user.send({ embeds: [dmEmbed], components: [dmButtons] });

                // Track this edit session
                await TemporaryRegistration.upsert({
                discorduser: userId,
                eventId: event.id,
                event: event.name,
                stage: 'manageExisting',
                });
            } catch (dmErr) {
                logger.warn('Could not DM user current registration:', dmErr);
            }

            return;
        }


          // Check capacity to decide reserve vs seat-pick flow
          const occupied = await EventUsersModel.count({ where: { eventId, reserve: false } });
          const capacity = Number(event.seatsavailable || 0);
          const isReserve = occupied >= capacity;

          if (isReserve) {
            // --- RESERVE FLOW ---
            await TemporaryRegistration.upsert({
              discorduser: userId,
              eventId,
              event: event.name,
              nickname: user.nickname,
              firstname: user.firstname,
              lastname: user.lastname,
              email: user.email,
              country: user.country,
              reserve: true,
              stage: 'showingReserveConfirmation',
            });

            // DM reserve confirmation with buttons (guard for closed DMs)
            try {
              const snap = await getRegistrationSnapshot(userId);
              const username = interaction.user.username;
              const { embed, row } = buildReserveConfirmEmbed({ username, eventName: event.name, snap, discordUsername: interaction.user.username });
              await interaction.user.send({ embeds: [embed], components: [row] });
            } catch (dmErr) {
              logger.warn('Could not DM user reserve confirmation:', dmErr);
              if (interaction.inGuild()) {
                await interaction.reply({
                  content: 'I cannot DM you. Please enable DMs from server members or DM me first, then try again.',
                  ephemeral: true
                });
              } else {
                try { await interaction.deferUpdate(); } catch { }
              }
              return;
            }

            // Only notify in guild context
            if (interaction.channel?.type !== ChannelType.DM) {
              const notify = buildCheckDMsEmbed('Reserve Registration', event.name, '#FFA500');
              await interaction.reply({ embeds: [notify], ephemeral: true });
            }

          } else {
            // --- SEAT PICK FLOW ---
            await TemporaryRegistration.upsert({
              discorduser: userId,
              eventId,
              event: event.name,
              nickname: user.nickname,
              firstname: user.firstname,
              lastname: user.lastname,
              email: user.email,
              country: user.country,
              reserve: false,
              stage: 'collectingPreferredSeats',
            });

            // DM seating map + seat prompt
            try {
              const seatingMapBuffer = await generateCurrentSeatingMap(eventId);
              await interaction.user.send({
                files: [{ attachment: seatingMapBuffer, name: 'seating-map.png' }],
                content: "Here's the current seating map. Please review it before providing your preferred seats:",
              });
            } catch (err) {
              await interaction.user.send({ embeds: [buildSeatingMapErrorEmbed()] });
            }

            await interaction.user.send({ embeds: [buildSeatPromptEmbed()] });

            if (interaction.channel?.type !== ChannelType.DM) {
              const notify = buildCheckDMsEmbed('Seat Selection', event.name, '#28B81C');
              await interaction.reply({ embeds: [notify], ephemeral: true });
            }
          }

        } catch (err) {
          logger?.error?.('registration_confirm- handler error:', err);
          const emb = buildRegistrationFailedEmbed('Something went wrong while starting your registration. Please try again.');
          await interaction.reply({ embeds: [emb], ephemeral: true });
        }
        return; // IMPORTANT: stop further handling
      }

      // B) Other buttons still use TemporaryRegistration context (edit existing, continue, etc.)
      let ongoingRegistration = await TemporaryRegistration.findOne({ where: { discorduser: userId } });

      // Unregister buttons are the only ones that encode additional values via '-'
      if (customId.startsWith('confirm_unregistration-')) {
        const eventName = customId.substring('confirm_unregistration-'.length);
        try {
          const user = await UserModel.findOne({ where: { discorduser: userId } });
          const event = await EventModel.findOne({ where: { name: eventName } });
          const userRegistration = event && user
            ? await EventUsersModel.findOne({ where: { userId: user.id, eventId: event.id } })
            : null;

          if (!userRegistration) {
            return interaction.update({
              content: `You are not registered for the event "${eventName}".`,
              ephemeral: true,
              components: [],
            });
          }

          await userRegistration.destroy();
          await scheduleParticipantListUpdate(interaction.client, event.id);

          await interaction.update({ embeds: [buildRegistrationRemovedEmbed()], components: [] });

          logActivity(interaction.client, `User **${user.nickname}** (${interaction.user.tag}) has unregistered from the event **${eventName}**.`);
        } catch (error) {
          await interaction.update({ content: 'An error occurred while processing your request.', ephemeral: true, components: [] });
        }
        return;
      }

      // QUICK REGISTER FROM ANNOUNCEMENT
      if (customId.startsWith('register_event-')) {
        const [, rawEventId] = customId.split('-');
        const eventId = parseInt(rawEventId, 10);

        try {
            const event = await EventModel.findByPk(eventId);
            if (!event) {
                const emb = buildRegistrationFailedEmbed('That event no longer exists.');
                return interaction.reply({ embeds: [emb], ephemeral: true });
            }

            if (!event.regopen) {
              const bypass = await canBypassRegistrationLock(interaction, event.id);
              if (!bypass) {
                const msg = 'Registration is currently closed for this event.';
                if (interaction.inGuild?.()) {
                  await interaction.reply({ content: msg, ephemeral: true }).catch(()=>{});
                } else {
                  try { await interaction.deferUpdate(); } catch {}
                }
                return;
              }
            }

            let user = await UserModel.findOne({ where: { discorduser: userId } });

            // 1) BRAND-NEW USER: start full account flow in DM
            if (!user) {
                await TemporaryRegistration.upsert({
                    discorduser: userId,
                    eventId,
                    event: event.name,
                    stage: 'collectingNickname',
                });

                // DM intro + ask for nickname (kept inline; these are unique onboarding prompts)
                const intro = new EmbedBuilder()
                    .setTitle(`You are now registering for **__${event.name}__**`)
                    .setDescription(
                    'Please fill in your account details first.\n\n' +
                    'You can stop/abort anytime by typing **!abort**.\n' +
                    'You’ll be able to edit responses before final submit.'
                    )
                    .setColor('#28B81C');

                const askNick = new EmbedBuilder()
                    .setTitle('Nickname')
                    .setDescription('Please provide your nickname.')
                    .setColor('#0089E4');

                await interaction.user.send({ embeds: [intro] });
                await interaction.user.send({ embeds: [askNick] });

                if (interaction.channel?.type !== ChannelType.DM) {
                    const notify = buildCheckDMsEmbed('Registration', event.name, '#28B81C');
                    await interaction.reply({ embeds: [notify], ephemeral: true });
                }
                return;
            }

            // 2) ALREADY REGISTERED? -> mirror /register flow
            const existing = await EventUsersModel.findOne({ where: { userId: user.id, eventId } });
            if (existing) {
                // a) ephemeral notice in guild
                if (interaction.channel?.type !== ChannelType.DM) {
                    const notice = buildAlreadyRegisteredNotice({ eventName: event.name });
                    await interaction.reply({ embeds: [notice], ephemeral: true });
                }

                // b) set a lightweight temp context so the DM buttons know which event
                await TemporaryRegistration.upsert({
                    discorduser: userId,
                    eventId,
                    event: event.name,
                    stage: 'manageExisting', // marker so our button handlers know this came from "already registered" manage screen
                });

                // c) DM the unified current-registration card (with seat/reserve) + buttons
                const snap = await getRegistrationSnapshot(userId);
                const isReserve = !!existing.reserve;
                const seat = existing.seat || null; // could be null if reserve

                const dmEmbed = buildCurrentRegistrationEmbed({
                    eventName: event.name,
                    discordUsername: interaction.user.username,
                    userSnap: snap,
                    seat,
                    isReserve,
                });
                const dmButtons = buildManageRegistrationButtons();

                try {
                    await interaction.user.send({ embeds: [dmEmbed], components: [dmButtons] });
                } catch (dmErr) {
                    logger.warn('Could not DM current-registration card:', dmErr);
                    if (interaction.inGuild()) {
                    const emb = buildRegistrationFailedEmbed('I cannot DM you. Please enable DMs from server members or DM me first, then try again.');
                    await interaction.followUp?.({ embeds: [emb], ephemeral: true }).catch(() => {});
                    }
                }
                return;
            }


          // 3) RETURNING USER: show Account summary first (Confirm/Edit/Cancel)
          await TemporaryRegistration.upsert({
            discorduser: userId,
            eventId,
            event: event.name,
            nickname: user.nickname,
            firstname: user.firstname,
            lastname: user.lastname,
            email: user.email,
            country: user.country,
            reserve: false,
            stage: 'showingAccountConfirm',
          });

          const snap = await getRegistrationSnapshot(userId);
          const { embed, row } = buildAccountExistsEmbed({ eventName: event.name, snap, discordUsername: interaction.user.username });
          await interaction.user.send({ embeds: [embed], components: [row] });

          if (interaction.channel?.type !== ChannelType.DM) {
            const notify = buildCheckDMsEmbed('Registration', event.name, '#28B81C');
            await interaction.reply({ embeds: [notify], ephemeral: true });
          }
        } catch (err) {
          logger?.error?.('register_event handler error:', err);
          if (!interaction.replied && !interaction.deferred) {
            const emb = buildRegistrationFailedEmbed('Sorry, could not start registration. Please try again.');
            await interaction.reply({ embeds: [emb], ephemeral: true });
          }
        }
        return;
      }

        if (customId === 'account_confirm') {
            try {
            const temp = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
            if (!temp) {
                const emb = buildNoOngoingRegEmbed();
                // If this somehow happens in a guild, ephemeral reply is fine.
                if (interaction.inGuild()) {
                return interaction.reply({ embeds: [emb], ephemeral: true });
                } else {
                // In DMs, just update the message to clear the buttons
                try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch { }
                return;
                }
            }

            const event = await EventModel.findByPk(temp.eventId);
            if (!event) {
                const emb = buildRegistrationFailedEmbed('That event no longer exists.');
                if (interaction.inGuild()) {
                return interaction.reply({ embeds: [emb], ephemeral: true });
                } else {
                try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch { }
                return;
                }
            }

            // capacity check...
            const occupied = await EventUsersModel.count({ where: { eventId: temp.eventId, reserve: false } });
            const capacity = Number(event.seatsavailable || 0);
            const isReserve = occupied >= capacity;

            if (isReserve) {
                temp.reserve = true;
                temp.stage = 'showingReserveConfirmation';
                await temp.save();

                // DM next step (guard for closed DMs)
                try {
                const snap = await getRegistrationSnapshot(userId);
                const { embed, row } = buildReserveConfirmEmbed({
                    username: interaction.user.username,
                    eventName: event.name,
                    snap, discordUsername: interaction.user.username
                });
                await interaction.user.send({ embeds: [embed], components: [row] });

                } catch (dmErr) {
                logger.warn('Could not DM user reserve confirmation:', dmErr);
                if (interaction.inGuild()) {
                    await interaction.reply({
                    content: 'I cannot DM you. Please enable DMs from server members or DM me first, then try again.',
                    ephemeral: true
                    });
                } else {
                    try { await interaction.deferUpdate(); } catch { }
                }
                return;
                }

                // ✅ Acknowledge the original button without sending a new message:
                if (interaction.channel?.type === ChannelType.DM) {
                try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch { await interaction.deferUpdate().catch(() => { }); }
                } else {
                await interaction.deferUpdate().catch(() => { });
                }
            } else {
                // Seat selection flow
                temp.reserve = false;
                temp.stage = 'collectingPreferredSeats';
                await temp.save();

                // DM map + prompt
                try {
                const seatingMapBuffer = await generateCurrentSeatingMap(temp.eventId);
                await interaction.user.send({
                    files: [{ attachment: seatingMapBuffer, name: 'seating-map.png' }],
                    content: "Here's the current seating map. Please review it before providing your preferred seats:",
                });
                } catch (err) {
                await interaction.user.send({ embeds: [buildSeatingMapErrorEmbed()] });
                }

                await interaction.user.send({ embeds: [buildSeatPromptEmbed()] });

                // ✅ Acknowledge the click without sending extra messages
                if (interaction.channel?.type === ChannelType.DM) {
                try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch { await interaction.deferUpdate().catch(() => { }); }
                } else {
                await interaction.deferUpdate().catch(() => { });
                }
            }
            } catch (err) {
                logger?.error?.('account_confirm handler error:', err);
                // In guild, it’s OK to send an ephemeral error; in DM just silently ack
                if (interaction.inGuild()) {
                    if (!interaction.replied && !interaction.deferred) {
                    const emb = buildRegistrationFailedEmbed();
                    await interaction.reply({ embeds: [emb], ephemeral: true });
                    }
                } else {
                    try { await interaction.deferUpdate(); } catch { }
                }
            }
            return;
        }

        if (customId === 'cancel_unregistration') {
            await interaction.update({ embeds: [buildRegistrationStillActiveEmbed()], components: [] });
            return;
        }

        // Handle legacy "registration_confirm" (no event id) — used for editing existing registration
        if (customId === 'registration_confirm') {
            if (!ongoingRegistration) {
                const regNoOngoingEmbed = buildNoOngoingRegEmbed();
                await interaction.reply({ embeds: [regNoOngoingEmbed], ephemeral: true });
                return;
            }
            // Clean up the temp reg here; the old flow expects 'registration_continue' to be used next
            await TemporaryRegistration.destroy({ where: { discorduser: userId } });
            ongoingRegistration = null;
            await interaction.reply({ embeds: [buildNoChangesUpdateEmbed('this event')], ephemeral: true });
            return;
        }

        if (!ongoingRegistration) {
            // One-off embed
            const regAlreadyCancelledEmbed = new EmbedBuilder()
                .setTitle('Already Cancelled')
                .setDescription('You have already completed or cancelled the registration process.')
                .setColor('#0089E4');
            await interaction.reply({ embeds: [regAlreadyCancelledEmbed], ephemeral: true });
            return;
        }

      // ----- Edit / Continue / Country buttons that rely on TemporaryRegistration -----
        if (customId === 'registration_cancel') {
            await TemporaryRegistration.destroy({ where: { discorduser: userId } });
            await interaction.reply({ embeds: [buildRegistrationCancelledEmbed()], ephemeral: true });
            return;
        }

        if (customId === 'registration_edit') {
            // Show split choice: Account or Seat
            const event = await EventModel.findByPk(ongoingRegistration.eventId);
            if (!event) {
                const emb = buildRegistrationFailedEmbed('Event not found. Please try again.');
                return interaction.reply({ embeds: [emb], ephemeral: true });
            }

            // Mark as an edit session
            ongoingRegistration.editingExisting = true;
            await ongoingRegistration.save();

            const choiceEmbed = buildEditChoiceEmbed(event.name);
            const choiceButtons = buildEditChoiceButtons(); // from utils/embeds.js

            // Update the same message if in DM, otherwise reply ephemeral
            try {
                await interaction.update({ embeds: [choiceEmbed], components: [choiceButtons] });
            } catch {
                await interaction.reply({ embeds: [choiceEmbed], components: [choiceButtons], ephemeral: true });
            }
            return;
        }

        // User chose to edit only seat
        if (customId === 'reg_edit_seat') {
          const temp = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
          if (!temp) {
            const emb = buildRegistrationFailedEmbed('No ongoing registration found.');
            return interaction.reply({ embeds: [emb], ephemeral: true });
          }

          temp.editMode = 'seatOnly';
          temp.editingExisting = true; 
          temp.stage = 'collectingPreferredSeats';
          await temp.save();

          // DM seating map + prompt
          try {
            const seatingMapBuffer = await generateCurrentSeatingMap(temp.eventId);
            await interaction.user.send({
              files: [{ attachment: seatingMapBuffer, name: 'seating-map.png' }],
              content: "Here's the current seating map. Please review it before providing your preferred seats:",
            });
          } catch {
            await interaction.user.send({ embeds: [buildSeatingMapErrorEmbed()] });
          }
          await interaction.user.send({ embeds: [buildSeatPromptEmbed()] });

          // Disable the choice buttons where the user clicked
          try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch {}
          return;
        }



        if (customId === 'reg_nochanges') {
            const temp = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
            const event = temp ? await EventModel.findByPk(temp.eventId) : null;
            const emb = buildNoChangesUpdateEmbed(event?.name || 'this event');
            try {
                await interaction.update({ embeds: [emb], components: [] });
            } catch {
                if (interaction.inGuild()) {
                await interaction.reply({ embeds: [emb], ephemeral: true });
                } else {
                await interaction.user.send({ embeds: [emb] });
                try { await interaction.deferUpdate(); } catch {}
                }
            }
            return;
        }

        if (customId === 'reg_edit') {
            const temp = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
            const eventRow = temp ? await EventModel.findByPk(temp.eventId) : null;
            const eventName = eventRow?.name || 'the event';

            const emb = buildEditChoiceEmbed(eventName);
            const row = buildEditChoiceButtons();

            try {
                await interaction.update({ embeds: [emb], components: [row] });
            } catch {
                try { await interaction.deferUpdate(); } catch {}
            }
            return;
        }

        // User chose to edit only account details
        if (customId === 'reg_edit_account') {
          const temp = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
          if (!temp) {
            const emb = buildRegistrationFailedEmbed('No ongoing registration found.');
            return interaction.reply({ embeds: [emb], ephemeral: true });
          }

          // Mark account-only edit and start at nickname
          temp.editMode = 'accountOnly';
          temp.editingExisting = true;        // also mark “editing” so we suppress congrats later
          temp.stage = 'collectingNickname';
          await temp.save();

          const askNick = new EmbedBuilder()
            .setTitle('Nickname')
            .setDescription('Please provide your nickname.')
            .setColor('#0089E4');

          // Update current message to disable previous buttons, then DM the prompt
          try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch {}
          await interaction.user.send({ embeds: [askNick] });
          return;
        }


        if (customId === 'registration_continue') {
          const inDM = interaction.channel?.isDMBased?.() === true;

          // Pre-acknowledge
          if (!inDM) {
            if (!interaction.deferred && !interaction.replied) {
              await interaction.deferReply({ ephemeral: true });
            }
          } else {
            if (!interaction.deferred && !interaction.replied) {
              try { await interaction.deferUpdate(); } catch {}
            }
          }

          try {
            let temp = await TemporaryRegistration.findOne({ where: { discorduser: interaction.user.id } });
            if (!temp) {
              if (!inDM) {
                const emb = buildRegistrationFailedEmbed('Could not find your ongoing registration.');
                try { await interaction.editReply({ embeds: [emb] }); } catch {}
              }
              return;
            }

            const userId = interaction.user.id;

            // STEP B: Upsert user (guard each field to avoid clobbering)
            let user = await UserModel.findOne({ where: { discorduser: userId } });
            if (user) {
              const updates = {};
              if (temp.nickname)  updates.nickname  = temp.nickname;
              if (temp.firstname) updates.firstname = temp.firstname;
              if (temp.lastname)  updates.lastname  = temp.lastname;
              if (temp.email)     updates.email     = temp.email;
              if (typeof temp.country !== 'undefined' && temp.country !== null) {
                updates.country = temp.country;
              }
              Object.assign(user, updates);
              await user.save();
            } else {
              const payload = {
                discorduser: userId,
                nickname:  temp.nickname,
                firstname: temp.firstname,
                lastname:  temp.lastname,
                email:     temp.email,
                country:   temp.country,
              };
              user = await UserModel.create(payload);
            }

            // STEP C: Load event
            const eventDetails = await EventModel.findByPk(temp.eventId);
            if (!eventDetails) throw new Error('Event not found for the given ID');
            const eventName = eventDetails.name;

            // Snapshot existing EventUsers row (for change detection)
            const existingEventUser = await EventUsersModel.findOne({
              where: { userId: user.id, eventId: temp.eventId },
            });
            const isEditing = !!temp.editingExisting || !!existingEventUser;
            const prevSeat = existingEventUser ? existingEventUser.seat : null;
            const prevReserve = existingEventUser ? !!existingEventUser.reserve : false;

            // STEP D: re-read temp, compute flags
            temp = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
            const isReserve = !!temp.reserve;

            // STEP E: Upsert EventUsers row
            if (user && eventDetails) {
              const existing = await EventUsersModel.findOne({
                where: { userId: user.id, eventId: temp.eventId },
              });
              if (existing) {
                await existing.update({
                  seat:   temp.seat,
                  status: 'confirmed',
                  reserve: isReserve,
                });
              } else {
                await EventUsersModel.create({
                  userId:  user.id,
                  eventId: temp.eventId,
                  seat:    temp.seat,
                  status:  'confirmed',
                  reserve: isReserve,
                });
              }
            }

            // STEP F: DM/update UX
            const afterRow = await EventUsersModel.findOne({
              where: { userId: user.id, eventId: temp.eventId },
            });

            const after = afterRow ? {
              seat: afterRow.seat,
              haspaid: !!afterRow.haspaid,
              reserve: !!afterRow.reserve,
              paidAt:  afterRow.paidAt || null,
            } : {
              seat: temp.seat ?? null,
              haspaid: false,
              reserve: !!temp.reserve,
              paidAt: null,
            };

            // 1) User-facing DM/ephemeral feedback
            if (isReserve) {
              // Reserve flow → show a clear “you’re on the reserve list” result
              const snap = await getRegistrationSnapshot(interaction.user.id);
              const reserveEmbed = buildReserveResultEmbed({
                eventName,
                snap,
                discordTag: interaction.user.tag,
                discordUsername: interaction.user.username,
              });

              if (inDM) {
                try {
                  await interaction.update({ embeds: [reserveEmbed], components: [] });
                } catch {
                  try { await interaction.user.send({ embeds: [reserveEmbed] }); } catch {}
                  try { await interaction.deferUpdate(); } catch {}
                }
              } else {
                try { await interaction.user.send({ embeds: [reserveEmbed] }); } catch {}
                // Light ephemeral confirmation in the guild (optional)
                try { await interaction.editReply({ embeds: [buildRegistrationSubmittedEmbed()] }); } catch {}
              }
            } else {
              // Non-reserve flow
              if (isEditing) {
                const updated = new EmbedBuilder()
                  .setTitle('Registration updated')
                  .setDescription(
                    temp.seat
                      ? `Your seat has been updated to **#${temp.seat}** for **${eventName}**.`
                      : `Your registration for **${eventName}** has been updated.`
                  )
                  .setColor('#28B81C');

                if (inDM) {
                  try {
                    // Replace the clicked DM message
                    await interaction.update({ embeds: [updated], components: [] });
                  } catch {
                    try { await interaction.user.send({ embeds: [updated] }); } catch {}
                    try { await interaction.deferUpdate(); } catch {}
                  }
                } else {
                  try { await interaction.user.send({ embeds: [updated] }); } catch {}
                  try { await interaction.editReply({ embeds: [buildRegistrationSubmittedEmbed()] }); } catch {}
                }
              } else {
                // First-time registration (non-reserve) → send Congratulations + Payment details
                const safeCountry = temp.country ?? user.country ?? null;

                // Load per-event payment config safely (fallback to global/default on any error)
                let perEventCfg;
                try {
                  perEventCfg = getPaymentConfigForEvent(eventDetails);
                } catch (e) {
                  logger.warn('[payment-config] failed to load per-event config, falling back to default:', e?.message || e);
                  try {
                    perEventCfg = getPaymentConfigForEvent(null); // your default/global
                  } catch {
                    perEventCfg = {}; // absolute fallback — still renders
                  }
                }

                // Build embeds; if anything throws, degrade gracefully to a minimal confirmation
                let registrationEmbed, paymentDetailsEmbed;
                try {
                  [registrationEmbed, paymentDetailsEmbed] = createConfirmationEmbeds({
                    discorduser:     interaction.user.tag,
                    discordUsername: interaction.user.username,
                    nickname:        temp.nickname,
                    firstname:       temp.firstname,
                    lastname:        temp.lastname,
                    email:           temp.email,
                    country:         safeCountry,
                    seat:            temp.seat,
                    event:           eventDetails,
                  }, perEventCfg);
                } catch (e) {
                  logger.error('[createConfirmationEmbeds] error building embeds:', e);
                  registrationEmbed = new EmbedBuilder()
                    .setTitle(`Congratulations ${interaction.user.tag}! 🎉 🎊`)
                    .setDescription(`You have registered to attend **__${eventName}__**`)
                    .setColor('#28B81C');
                  // optional tiny fallback payment panel
                  paymentDetailsEmbed = new EmbedBuilder()
                    .setTitle('Payment details')
                    .setDescription('Payment instructions are temporarily unavailable. Please contact an admin if this persists.')
                    .setColor('#28B81C');
                }

                if (inDM) {
                  try {
                    // Replace the clicked DM message with the two embeds
                    await interaction.update({ embeds: [registrationEmbed, paymentDetailsEmbed], components: [] });
                  } catch {
                    // Fallback: send as new DMs and ack the button
                    try { await interaction.user.send({ embeds: [registrationEmbed, paymentDetailsEmbed] }); } catch {}
                    try { await interaction.deferUpdate(); } catch {}
                  }
                } else {
                  // In guild: DM the user and show a small ephemeral confirmation
                  try { await interaction.user.send({ embeds: [registrationEmbed, paymentDetailsEmbed] }); } catch {}
                  try { await interaction.editReply({ embeds: [buildRegistrationSubmittedEmbed()] }); } catch {}
                }
              }
            }

            // 2) Admin logging (unchanged from your current block)
            if (isReserve) {
              // First-time reserve OR switching to reserve
              logActivity(interaction.client, formatEventUserLog(interaction.user.tag, {
                action:    existingEventUser ? 'updated' : 'registered',
                eventName: eventName,
                eventId:   temp.eventId,
                nick:      user.nickname,
                userId:    user.id,
                seat:      after.seat,
                paid:      after.haspaid,
                reserve:   after.reserve,
                paidAt:    after.paidAt,
              }));
            } else {
              if (isEditing) {
                const diffs = [];
                if (prevSeat !== after.seat)       diffs.push({ label: 'Seat',    before: prevSeat,       after: after.seat });
                if (prevReserve !== after.reserve) diffs.push({ label: 'Reserve', before: !!prevReserve,  after: !!after.reserve });

                if (diffs.length === 0) {
                  logActivity(interaction.client, formatEventUserLog(interaction.user.tag, {
                    action:    'updated',
                    eventName: eventName,
                    eventId:   temp.eventId,
                    nick:      user.nickname,
                    userId:    user.id,
                    seat:      after.seat,
                    paid:      after.haspaid,
                    reserve:   after.reserve,
                    paidAt:    after.paidAt,
                  }));
                } else {
                  logActivity(interaction.client, formatEventUserDiffLog(interaction.user.tag, {
                    eventName: eventName,
                    eventId:   temp.eventId,
                    nick:      user.nickname,
                    userId:    user.id,
                    changes:   diffs,
                  }));
                }
              } else {
                // First-time non-reserve registration → “registered”
                logActivity(interaction.client, formatEventUserLog(interaction.user.tag, {
                  action:    'registered',
                  eventName: eventName,
                  eventId:   temp.eventId,
                  nick:      user.nickname,
                  userId:    user.id,
                  seat:      after.seat,
                  paid:      after.haspaid,
                  reserve:   after.reserve,
                  paidAt:    after.paidAt,
                }));
              }
            }

            // STEP G: Participant list only when it matters
            const seatChanged = prevSeat !== temp.seat;
            const reserveChanged = prevReserve !== !!temp.reserve;
            const shouldUpdateParticipants = !existingEventUser || seatChanged || reserveChanged;

            if (shouldUpdateParticipants) {
              await scheduleParticipantListUpdate(interaction.client, temp.eventId);
            }

            // Clean up temp row
            await TemporaryRegistration.destroy({ where: { discorduser: userId } });

          } catch (error) {
            logger.error('[registration_continue] finalize error:', error);
            if (inDM) {
              try { await interaction.deferUpdate(); } catch {}
            } else {
              const regErrorFinalizingEmbed = buildRegistrationFailedEmbed('There was an error finalizing your registration. Please try again later.');
              try { await interaction.editReply({ embeds: [regErrorFinalizingEmbed] }); } catch {}
            }
          }
          return;
        }



        if (customId === 'country_yes') {
          const userId = interaction.user.id;
          let temp = await TemporaryRegistration.findOne({ where: { discorduser: userId } });

          if (!temp || !temp.unconfirmedCountry) {
            const emb = buildRegistrationFailedEmbed('Could not find your ongoing registration.');
            await interaction.reply({ embeds: [emb], ephemeral: true });
            return;
          }

          const inDM = interaction.channel?.isDMBased?.() === true;
          if (!inDM) {
            if (!interaction.deferred && !interaction.replied) {
              await interaction.deferReply({ ephemeral: true }).catch(()=>{});
            }
          } else if (!interaction.deferred && !interaction.replied) {
            try { await interaction.deferUpdate(); } catch {}
          }

          // Apply country
          temp.country = temp.unconfirmedCountry;
          temp.unconfirmedCountry = null;

          // 🔒 ACCOUNT-ONLY: stop here, send account-confirm, DO NOT seat-check
          if (temp.editMode === 'accountOnly') {
            temp.stage = 'showingAccountConfirm';
            await temp.save();

            const eventRow = await EventModel.findByPk(temp.eventId);
            const snap = await getRegistrationSnapshot(userId);

            const confirmEmbed = buildAccountDetailsConfirmEmbed({
              eventName: eventRow?.name || 'this event',
              snap,
              discordUsername: interaction.user.username,
            });

            const confirmRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('registration_continue').setLabel('Confirm').setStyle(3),
              new ButtonBuilder().setCustomId('registration_cancel').setLabel('Cancel').setStyle(4),
            );

            await interaction.user.send({ embeds: [confirmEmbed], components: [confirmRow] }).catch(()=>{});
            if (!inDM) {
              await interaction.editReply({ content: 'Check your DMs to continue.', embeds: [] }).catch(()=>{});
            } else {
              try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch {}
            }
            return; // ✅ do not proceed into seat logic
          }

          // ---------- NORMAL (not accountOnly): seat / reserve branching ----------
          await temp.save();

          const seatCheck = await getAvailableSeatsForEvent(temp.eventId, temp.discorduser);

          let isReserve;
          if (!seatCheck.success || seatCheck.availableSeats <= 0) {
            isReserve = true;
          } else if (temp && !temp.reserve) {
            isReserve = false;
          } else {
            isReserve = true;
          }

          if (temp.reserve !== isReserve) {
            temp.reserve = isReserve;
            await TemporaryRegistration.update({ reserve: isReserve }, { where: { discorduser: userId } });
          }

          if (isReserve) {
            temp.stage = 'showingReserveConfirmation';
            await temp.save();

            try {
              const snap = await getRegistrationSnapshot(userId);
              const { embed, row } = buildReserveConfirmEmbed({
                username: interaction.user.username,
                eventName: seatCheck.eventName,
                snap,
                discordUsername: interaction.user.username
              });
              await interaction.user.send({ embeds: [embed], components: [row] });
            } catch (dmErr) {
              if (interaction.inGuild()) {
                await interaction.editReply({
                  content: 'I can’t DM you. Please enable DMs from server members or DM me first, then try again.',
                  embeds: []
                }).catch(()=>{});
              } else {
                try { await interaction.deferUpdate(); } catch {}
              }
              return;
            }

            if (interaction.inGuild()) {
              await interaction.editReply({ embeds: [buildCheckDMsEmbed('Continue in DMs', seatCheck.eventName, '#28B81C')] }).catch(()=>{});
            } else {
              try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch {}
            }
          } else {
            temp.stage = 'collectingPreferredSeats';
            await temp.save();

            try {
              const seatingMapBuffer = await generateCurrentSeatingMap(temp.eventId);
              await interaction.user.send({
                files: [{ attachment: seatingMapBuffer, name: 'seating-map.png' }],
                content: "Here's the current seating map. Please review it before providing your preferred seats:",
              });
            } catch (error) {
              await interaction.user.send({ embeds: [buildSeatingMapErrorEmbed()] });
            }

            await interaction.user.send({ embeds: [buildSeatPromptEmbed()] });
            if (interaction.inGuild()) {
              await interaction.editReply({ embeds: [buildCheckDMsEmbed('Continue in DMs', seatCheck.eventName, '#28B81C')] }).catch(()=>{});
            } else {
              try { await interaction.update({ components: disableAllButtonsFromMessage(interaction.message) }); } catch {}
            }
          }
          return;
        }




        if (customId === 'country_no') {
            if (ongoingRegistration) {
            await interaction.deferReply({ ephemeral: true });

            ongoingRegistration.unconfirmedCountry = null;
            ongoingRegistration.stage = 'collectingCountry';
            try {
                await ongoingRegistration.save();
            } catch (error) {
                const emb = buildRegistrationFailedEmbed('An error occurred. Please try again later.');
                await interaction.reply({ embeds: [emb], ephemeral: true });
                return;
            }

            // Country prompt (unique copy; no standard builder)
            const regCountryEmbed = new EmbedBuilder()
                .setTitle('Country')
                .setDescription('Please provide your country of residence.\n\nUse a two letter country code [alpha-2-code] \nhttps://www.iban.com/country-codes')
                .setColor('#0089E4');
            await interaction.user.send({ embeds: [regCountryEmbed] });
            await interaction.editReply({ content: 'Check your DMs to continue.', embeds: [] });
            } else {
            const emb = buildRegistrationFailedEmbed("Couldn't find your ongoing registration.");
            await interaction.reply({ embeds: [emb], ephemeral: true });
            }
            return;
        }
    }
  },
};

// ---------- Autocomplete helpers ----------
async function handleEventAutocomplete(interaction) {
  const query = (interaction.options.getFocused() || '').toString().toLowerCase();
  const events = await listEvents({ all: true });
  const filtered = events.filter(e => (e?.name || '').toLowerCase().includes(query));
  const choices = filtered
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' }))
    .slice(0, 25)
    .map(e => ({ name: e.name, value: e.id.toString() }));
  await interaction.respond(choices);
}

async function handleEventAutocompleteForEventAdmin(interaction) {
  const query = (interaction.options.getFocused() || '').toString().toLowerCase();
  const events = await listEvents({ all: true });

  // Check per event if the caller is an admin for it
  const checks = await Promise.all(events.map(async (e) => {
    try {
      const ok = await isEventAdminForEvent(interaction, e.id);
      return ok ? e : null;
    } catch { return null; }
  }));

  const ownEvents = checks.filter(Boolean);

  const filtered = ownEvents.filter(e => (e?.name || '').toLowerCase().includes(query));

  const choices = filtered
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' }))
    .slice(0, 25)
    .map(e => ({ name: e.name, value: e.id.toString() }));

  await interaction.respond(choices);
}

async function handleRegisterEventAutocomplete(interaction) {
  const q = (interaction.options.getFocused() || '').toString().toLowerCase();
  const now = new Date();

  const isGlobalAdmin = await (async () => {
    try { return await isAdmin(interaction); } catch { return false; }
  })();

  const events = await listEvents({ all: true });
  const visible = [];

  for (const e of events) {
    const name = (e?.name || '');
    if (q && !name.toLowerCase().includes(q)) continue;

    // Never show past events
    if (e.enddate && new Date(e.enddate) < now) continue;

    const open = !!e.regopen;

    if (open) {
      // Everyone can see open (upcoming/ongoing) events
      visible.push({ e, closedLabel: false });
      continue;
    }

    // Closed (but future/ongoing) — only admins/event-admins
    if (isGlobalAdmin) {
      visible.push({ e, closedLabel: true });
      continue;
    }

    try {
      const isEA = await isEventAdminForEvent(interaction, e.id);
      if (isEA) visible.push({ e, closedLabel: true });
    } catch { /* ignore */ }
  }

  const choices = visible
    .sort((a, b) => (a.e.name || '').localeCompare(b.e.name || '', 'en', { sensitivity: 'base' }))
    .slice(0, 25)
    .map(({ e, closedLabel }) => ({
      name: closedLabel ? `${e.name} [Closed]` : e.name,
      value: e.id.toString(),
    }));

  await interaction.respond(choices);
}

async function handleUserAutocomplete(interaction) {
  try {
    const searchTerm = interaction.options.getString('nickname')?.toLowerCase() || '';
    const users = await listUsers();
    const matchingUsers = users
      .filter(user => user.nickname.toLowerCase().includes(searchTerm))
      .slice(0, 25)
      .map(user => ({ name: user.nickname, value: user.nickname }));
    await interaction.respond(matchingUsers);
  } catch (error) {
    await interaction.respond([]);
  }
}

async function handleUserEventAutocomplete(interaction) {
  try {
    const nicknameOption = interaction.options._hoistedOptions.find(option => option.name === 'nickname');
    const userNickname = nicknameOption?.value || '';
    const user = await UserModel.findOne({ where: { nickname: userNickname } });
    if (!user) return await interaction.respond([]);

    const eventsForUser = await listEventsForUser(user.discorduser);
    if (!eventsForUser || eventsForUser.length === 0) return await interaction.respond([]);

    const eventSuggestions = eventsForUser.slice(0, 25).map(event => ({ name: event.name, value: event.id.toString() }));
    await interaction.respond(eventSuggestions);
  } catch (error) {
    await interaction.respond([]);
  }
}

async function handleUnregisterAutocomplete(interaction) {
  try {
    const userId = interaction.user.id;
    const user = await UserModel.findOne({ where: { discorduser: userId.toString() } });
    if (!user) return;

    const registeredEvents = await user.getEvents();
    const eventNames = registeredEvents.map(event => ({ name: event.name, value: event.name }));

    if (eventNames.length === 0) {
      await interaction.respond([{ name: 'You are not registered to any events', value: 'no_match' }]);
      return;
    }

    await interaction.respond(eventNames);
  } catch (error) {
    logger.error('Error in handleUnregisterAutocomplete:', error.message, error.stack);
  }
}

async function handleEventUserNicknameAutocomplete(interaction) {
  try {
    const eventId = interaction.options.getString('event');
    const query = (interaction.options.getFocused() || '').toString().toLowerCase();
    const eventRecord = await EventModel.findByPk(eventId, { include: [{ model: UserModel, as: 'users' }] });
    if (!eventRecord) return await interaction.respond([]);

    const userSuggestions = eventRecord.users
      .filter(u => (u?.nickname || '').toLowerCase().includes(query))
      .sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'en', { sensitivity: 'base' }))
      .slice(0, 25)
      .map(u => ({ name: u.nickname, value: u.nickname }));

    await interaction.respond(userSuggestions);
  } catch (error) {
    await interaction.respond([]);
  }
}

async function handleCountryAutocomplete(interaction) {
  try {
    const searchTerm = (interaction.options.getFocused() || '').toLowerCase();
    const matchingCountries = countries.filter(country => country.name.toLowerCase().includes(searchTerm)).slice(0, 25);
    await interaction.respond(matchingCountries);
  } catch (error) {
    await interaction.respond([]);
  }
}

async function handleChartIdAutocomplete(interaction) {
  // Optional privacy: only let bot admins see chart IDs
  if (!(await isAdmin(interaction))) {
    return interaction.respond([]);
  }

  const query = String(interaction.options.getFocused() || '').trim().toLowerCase();
  const dir = chartsCfg.chartsDir || './charts';

  let ids = new Set();

  try {
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const e of entries) {
        if (e.isDirectory()) {
          const fp = path.join(dir, e.name, 'chart.json');
          if (fs.existsSync(fp)) ids.add(e.name);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
          ids.add(path.basename(e.name, '.json'));
        }
      }
    }
  } catch (_) {
    // ignore FS errors; respond empty
  }

  let list = [...ids];
  if (query) list = list.filter(id => id.toLowerCase().includes(query));

  const choices = list.sort().slice(0, 25).map(id => ({ name: id, value: id }));
  return interaction.respond(choices);
}

async function handlePaymentConfigAutocomplete(interaction) {
  try {
    const q = String(interaction.options.getFocused() || '').toLowerCase();
    const cfgDir = path.join(process.cwd(), 'config');

    let files = [];
    try {
      files = fs.readdirSync(cfgDir, { withFileTypes: true })
        .filter(e => e.isFile() && /^paymentConfig_.*\.json$/i.test(e.name))
        .map(e => e.name);
    } catch {
      return interaction.respond([]);
    }

    // Build choices: pretty label, but keep the DB value (basename without .json)
    let choices = files.map(fn => {
      const base = path.basename(fn, '.json');                  // e.g. "paymentConfig_Sweden"
      const pretty = base.replace(/^paymentConfig_/i, '');      // e.g. "Sweden"
      return { name: pretty, value: base };
    });

    // Include a sentinel for default/global
    choices.unshift({ name: '— Use default/global —', value: '' });

    // Filter by either the pretty label or the raw base
    if (q) {
      choices = choices.filter(c =>
        c.name.toLowerCase().includes(q) || String(c.value).toLowerCase().includes(q)
      );
    }

    // Sort by pretty label, cap at 25
    choices = choices
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
      .slice(0, 25);

    await interaction.respond(choices);
  } catch {
    await interaction.respond([]);
  }
}


// ---------- Embeds for confirmations ----------
function createConfirmationEmbeds(data, paymentCfg) {
  const ev = data.event || {};
  const start = ev.startdate ? formatDisplayDate(ev.startdate) : 'TBA';
  const end   = ev.enddate ? formatDisplayDate(ev.enddate) : 'TBA';
  const loc   = ev.location || 'TBA';
  const seats = (typeof ev.seatsavailable === 'number') ? ev.seatsavailable.toString() : 'TBA';

  // currency: keep your prior fallback behavior if you want, or pull from paymentCfg if you encode it there
  const fee = (typeof ev.entryfee === 'number') ? `${ev.entryfee} ${paymentCfg?.currency || 'EUR'}` : `TBA ${paymentCfg?.currency || 'EUR'}`;

  const registrationEmbed = new EmbedBuilder()
    .setTitle(`Congratulations ${data.discorduser}!  🎉 🎊`)
    .setDescription(`You have registered to attend **__${ev.name || data.eventName || 'Unknown Event'}__**\n⠀`)
    .setColor('#28B81C')
    .addFields(
      { name: '🏩  **EVENT DETAILS**', value: '** **' },
      { name: '📍 Location', value: loc, inline: true },
      { name: '🧑‍🧑‍🧒‍🧒 Total seats', value: seats, inline: true },
      { name: '💶 Entry fee', value: `**${fee}**`, inline: true },
      { name: '🗓 Starts', value: start, inline: true },
      { name: '🗓 Ends', value: end, inline: true },
      { name: '** **', value: '** **', inline: true },
      { name: '** **', value: '** **', inline: false },

      { name: '👤  **USER REGISTRATION DETAILS**', value: '** **' },
      { name: '👾 Nickname', value: data.nickname, inline: true },
      { name: '👤 Discord User', value: data.discordUsername || data.discorduser || '—', inline: true },
      { name: '🗺️ Country', value: data.country ? `:flag_${String(data.country).toLowerCase()}:` : '—', inline: true },
      { name: '☝️ Firstname', value: data.firstname, inline: true },
      { name: '✌️ Lastname', value: data.lastname, inline: true },
      { name: '📧  E-mail address', value: data.email, inline: true },
      { name: '🪑 Assigned seat', value: data.seat ? `#${data.seat}` : 'Not Assigned', inline: true },
    )
    .setFooter({ text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀' });

  // Payment details embed using *per-event* cfg
  const paymentDetailsEmbed = new EmbedBuilder()
    .setTitle('Payment details')
    .setDescription(paymentCfg?.notes?.beforeList || '')
    .setColor('#28B81C')
    .addFields(buildPaymentFields(paymentCfg))
    .setFooter({ text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀' });

  return [registrationEmbed, paymentDetailsEmbed];
}


// ---------- HELPER FUNCTIONS ----------
function disableAllButtonsFromMessage(message) {
  try {
    return message.components.map(row => {
      const newRow = new ActionRowBuilder();
      newRow.addComponents(
        row.components.map(comp => ButtonBuilder.from(comp).setDisabled(true))
      );
      return newRow;
    });
  } catch {
    return [];
  }
}

function channelMentionFromRaw(raw) {
  const id = String(raw ?? '').match(/\d{5,}/)?.[0];
  return id ? `<#${id}>` : null;
}

async function canBypassRegistrationLock(interaction, eventId) {
  try {
    if (await isAdmin(interaction)) return true;
    return await isEventAdminForEvent(interaction, eventId);
  } catch {
    return false;
  }
}

