// utils/embeds.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');

// ---------- Shared helpers ----------
function flagOrDash(country) {
  return country ? `:flag_${country.toLowerCase()}:` : '—';
}

function userBlockFields(snap, discordUsername) {
  return [
    { name: '👾 Nickname', value: snap.nickname || '—', inline: true },
    { name: '👤 Discord User', value: discordUsername || '—', inline: true },
    { name: '🏁 Country', value: flagOrDash(snap.country), inline: true },
    { name: '☝️ Firstname', value: snap.firstname || '—', inline: true },
    { name: '✌️ Lastname', value: snap.lastname || '—', inline: true },
    { name: '📧 Email', value: snap.email || '—', inline: true },
  ];
}

// ---------- Reserve flow ----------
function buildReserveConfirmEmbed({ eventName, snap, discordUsername }) {
  const embed = new EmbedBuilder()
    .setTitle('No Available Seats')
    .setDescription(
      `⚠️ **${eventName}** is currently at __**MAX CAPACITY**__. ⚠️\n\n` +
      `To be added to the **__RESERVES LIST__** click **Confirm** below.\n` +
      `If a seat becomes available you will be contacted by an admin!`
    )
    .setColor('#FFA500')
    .addFields(...userBlockFields(snap, discordUsername))
    .setFooter({ text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('registration_continue').setLabel('Confirm').setStyle(3),
    new ButtonBuilder().setCustomId('registration_cancel').setLabel('Abort').setStyle(4)
  );

  return { embed, row };
}

function buildReserveResultEmbed({ eventName, snap, discordUsername }) {
  const embed = new EmbedBuilder()
    .setTitle('You have been added to the **reserves list**')
    .setDescription('An admin will contact you if a seat becomes available!')
    .setColor('#FFA500')
    .addFields(
      { name: '📍 Event', value: eventName, inline: false },
      ...userBlockFields(snap, discordUsername)
    )
    .setFooter({ text: '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀' });
  return embed;
}

// ---------- Account exists ----------
function buildAccountExistsEmbed({ eventName, snap, discordUsername }) {
  const embed = new EmbedBuilder()
    .setTitle(`Signup for **${eventName}**`)
    .setDescription('Verify your account details below and then click **Confirm** to continue the signup process.')
    .setColor('#FFA500')
    .addFields(...userBlockFields(snap, discordUsername))
    .setFooter({ text: '\n- To change your account details, click Edit\n- You can cancel your registration by clicking Abort or using !abort' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('account_confirm').setLabel('Confirm').setStyle(3),
    new ButtonBuilder().setCustomId('registration_edit').setLabel('Edit').setStyle(1),
    new ButtonBuilder().setCustomId('registration_cancel').setLabel('Abort').setStyle(4),
  );

  return { embed, row };
}

// ---------- Show current registration including seat/reserve ----------
function buildCurrentRegistrationEmbed({ eventName, discordUsername, userSnap, seat, isReserve }) {
  const seatLine = isReserve
    ? '🟧 **Reserve list**'
    : (seat ? `#${seat}` : 'Not assigned');

  return new EmbedBuilder()
    .setTitle('Current Event Registration')
    .setDescription(`**Event:** ${eventName}`)
    .setColor('#FFA500')
    .addFields(
      { name: '👾 Nickname', value: userSnap.nickname || '—', inline: true },
      { name: '👤 Discord User', value: discordUsername || '—', inline: true },
      { name: '🏁 Country', value: flagOrDash(userSnap.country), inline: true },
      { name: '☝️ Firstname', value: userSnap.firstname || '—', inline: true },
      { name: '✌️ Lastname', value: userSnap.lastname || '—', inline: true },
      { name: '📧 Email', value: userSnap.email || '—', inline: true },
      { name: '🪑 Seat', value: seatLine, inline: false },
    )
    .setFooter({ text: 'Please choose an option below.' });
}

function buildAccountDetailsConfirmEmbed({ eventName, snap, discordUsername }) {
  return new EmbedBuilder()
    .setTitle('Confirm Account Details')
    .setDescription(`Review your account details for **${eventName}** and press **Confirm**.\n(Your seat won’t be changed.)`)
    .setColor('#28B81C')
    .addFields(
      { name: '👾 Nickname', value: snap.nickname || '—', inline: true },
      { name: '👤 Discord User', value: discordUsername || '—', inline: true },
      { name: '🗺️ Country', value: flagOrDash(snap.country), inline: true },
      { name: '☝️ Firstname', value: snap.firstname || '—', inline: true },
      { name: '✌️ Lastname', value: snap.lastname || '—', inline: true },
      { name: '📧 Email', value: snap.email || '—', inline: true },
    );
}

// Unicode flag for a two-letter country code (renders in embed titles too), '' otherwise
function countryFlag(code) {
  if (!/^[A-Za-z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// ---------- Buttons for the current-registration card ----------
function buildManageRegistrationButtons(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reg_nochanges').setLabel('No Changes').setStyle(3),
    new ButtonBuilder().setCustomId('reg_edit').setLabel('Edit Registration').setStyle(1),
    new ButtonBuilder().setCustomId(`reg_unregister-${eventId}`).setLabel('Unregister').setStyle(4),
  );
}

// Yes/No confirmation shared by /unregister and the card's Unregister button
function buildUnregisterConfirm(eventName) {
  const embed = new EmbedBuilder()
    .setTitle('Unregister Confirmation')
    .setDescription(`Are you sure you want to remove your registration for\n **${eventName}** \n`)
    .setColor('#FFA500');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_unregistration-${eventName}`).setLabel('Yes').setStyle(4),
    new ButtonBuilder().setCustomId(`cancel_unregistration-${eventName}`).setLabel('No').setStyle(2),
  );
  return { embed, row };
}

// DM to a reserve whose turn has come: a seat is free for them
function buildSeatOfferEmbed({ eventId, eventName, position }) {
  const embed = new EmbedBuilder()
    .setTitle('A Seat Is Available For You')
    .setDescription(
      `Good news! You are **#${position}** on the reserves list for **${eventName}** and a seat has opened up for you.\n\n` +
      '• **Choose Seat** to pick your seat.\n' +
      '• **Decline** to stay on the reserves list, moved to the end of it.\n' +
      '• **Unregister** if you no longer want to attend.'
    )
    .setColor('#28B81C');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`reserve_claim-${eventId}`).setLabel('Choose Seat').setStyle(3),
    new ButtonBuilder().setCustomId(`reserve_decline-${eventId}`).setLabel('Decline').setStyle(2),
    new ButtonBuilder().setCustomId(`reg_unregister-${eventId}`).setLabel('Unregister').setStyle(4),
  );
  return { embed, row };
}

// ---------- Seat selection ----------
function buildSeatPromptEmbed() {
  return new EmbedBuilder()
    .setTitle('Preferred Seats')
    .setDescription('Please provide your preferred seats for the event.\nFormat: `3,11,29,...`')
    .setColor('#0089E4');
}

function buildSeatingMapErrorEmbed() {
  return new EmbedBuilder()
    .setTitle('Error Generating Seating Map')
    .setDescription('An error occurred while generating the seating map. Continuing with registration...')
    .setColor('#DD3601');
}

// ---------- Generic notices/status ----------
function buildRegistrationSubmittedEmbed() {
  return new EmbedBuilder()
    .setTitle('Registration submitted')
    .setDescription('Thanks! Your registration has been recorded.')
    .setColor('#28B81C');
}

function buildNoOngoingRegEmbed() {
  return new EmbedBuilder()
    .setTitle('No Registration In-Progress')
    .setDescription('No ongoing registration found. Please start again with **/register**.')
    .setColor('#0089E4');
}

function buildAlreadyRegisteredEmbed({ eventName, participantMention }) {
  const lines = [
    `You are already registered for **${eventName}**.`,
    '',
    '• Use **/status** to see your seat & payment status.',
  ];
  if (participantMention) {
    lines.push(`• Participant updates are posted in ${participantMention}.`);
  }
  return new EmbedBuilder()
    .setTitle('Already Registered')
    .setDescription(lines.join('\n'))
    .setColor('#FFA500');
}

function buildRegistrationCancelledEmbed() {
  return new EmbedBuilder()
    .setTitle('Registration Cancelled')
    .setDescription('You have cancelled the registration process.')
    .setColor('#0089E4');
}

function buildRegistrationRemovedEmbed() {
  return new EmbedBuilder()
    .setTitle('Registration Removed')
    .setDescription('You have successfully removed yourself from the event!')
    .setColor('#FFA500');
}

function buildRegistrationStillActiveEmbed() {
  return new EmbedBuilder()
    .setTitle('Registration Still Active')
    .setDescription('You have aborted your action to unregister from the event.')
    .setColor('#FFA500');
}

function buildRegistrationFailedEmbed(msg = 'Something went wrong. Please try again.') {
  return new EmbedBuilder()
    .setTitle('Registration Failed')
    .setDescription(msg)
    .setColor('#FF0000');
}

function buildCheckDMsEmbed(title, eventName, accent = '#28B81C') {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(`Check your DMs to continue registration for **${eventName}**.`)
    .setColor(accidentSafeColor(accent));
}

// DM: After pressing "No changes"
function buildNoChangesUpdateEmbed(eventName) {
  return new EmbedBuilder()
    .setTitle('No Changes')
    .setDescription(`No changes were made to your registration for **${eventName}**.`)
    .setColor('#FFA500');
}

// Guild ephemeral: Already registered notice
function buildAlreadyRegisteredNotice({ eventName }) {
  return new EmbedBuilder()
    .setTitle('Already Registered')
    .setDescription(`You are already registered for **${eventName}**.\nGo to your DMs to manage your registration.`)
    .setColor('#FFA500');
}

// DM: Split edit choices (Account vs Seat)
function buildEditChoiceEmbed(eventName) {
  return new EmbedBuilder()
    .setTitle('Edit Registration')
    .setDescription(`What would you like to edit for **${eventName}**?`)
    .setColor('#0089E4');
}
function buildEditChoiceButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reg_edit_account').setLabel('Account Details').setStyle(1),
    new ButtonBuilder().setCustomId('reg_edit_seat').setLabel('Seat Selection').setStyle(1),
    new ButtonBuilder().setCustomId('registration_cancel').setLabel('Cancel').setStyle(4),
  );
}

// small guard for color strings
function accidentSafeColor(c) { return typeof c === 'string' ? c : '#28B81C'; }

module.exports = {
  flagOrDash,
  userBlockFields,
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
  buildCurrentRegistrationEmbed,
  buildManageRegistrationButtons,
  buildUnregisterConfirm,
  buildSeatOfferEmbed,
  countryFlag,
  buildEditChoiceEmbed,
  buildEditChoiceButtons,
  buildNoChangesUpdateEmbed,
  buildAlreadyRegisteredNotice,
  buildRegistrationRemovedEmbed, 
  buildRegistrationStillActiveEmbed,
  buildAccountDetailsConfirmEmbed,
};
