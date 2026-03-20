# LDbot2 - Discord Event Bot

LDbot2 is a Discord bot for managing and organizing LAN events — handling registrations, seating, payments, and announcements.

> **Note:** This project is made public for reference purposes only and does not offer support, guarantees, or warranties outside of its original intent. Use or modify at your own risk.

---

## Features

- **Event management** — Create, edit, delete and list events with location, dates, seat capacity and entry fee
- **User registration** — Multi-step DM-based registration flow with nickname, personal details, country and seat selection
- **Seating charts** — Visual seating maps generated dynamically during registration and in the participant channel
- **Participant list** — Auto-updated participant list posted to a designated event channel
- **Reserve list** — Automatic reserve queue when seat capacity is reached
- **Payment tracking** — Track payment status per user per event
- **Announcements** — Post or schedule event announcements with a Register button
- **Countdown channel** — Automatic Discord channel name countdown to the next event
- **Event-scoped admins** — Assign an admin role per event for delegated management
- **Activity logging** — All admin actions logged to a designated log channel
- **Automated backups** — Scheduled SQLite database backups with configurable retention

---

## Requirements

- Node.js v18 or later
- npm
- A Discord bot application ([guide](https://discordjs.guide/preparations/setting-up-a-bot-application.html))
- PM2 (recommended for production)

---

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/fsk10/LDbot2.git
   cd LDbot2
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create `config.json` in the root directory:
   ```json
   {
     "BOT_TOKEN": "",
     "SERVER_ID": "",
     "CLIENT_ID": "",
     "BOT_OWNER_ID": ""
   }
   ```

4. Review `config/paymentConfig.json` and adjust the default payment methods to fit your needs. For venue-specific overrides, create `config/paymentConfig_<venue>.json` with the same structure and assign it per event.

5. Start the bot:
   ```bash
   node app.js
   ```
   Or with PM2:
   ```bash
   pm2 start app.js --name LDbot2
   ```

---

## Commands

### Admin Commands

| Command | Description |
|---------|-------------|
| `/adminset <setting> <value>` | Configure bot settings (admin role, log channel) |
| `/adminget <setting>` | Get current value of a bot setting |
| `/adminadd event` | Create a new event |
| `/adminadd user` | Add a user to the system |
| `/adminadd eventuser` | Add a user to a specific event |
| `/adminedit event` | Edit event details |
| `/adminedit user` | Edit user account details |
| `/adminedit eventuser` | Edit a user's seat, payment or reserve status |
| `/admindel event` | Delete an event |
| `/admindel user` | Remove a user from an event or delete entirely |
| `/adminlist events` | List all events |
| `/adminlist users` | List users, optionally filtered by event |
| `/adminannounce` | Post or schedule an event announcement |
| `/adminchart` | Manage seating charts |
| `/admincountdown` | Configure the countdown channel |
| `/adminbackup` | Configure and trigger database backups |
| `/admindownloadimages` | Bulk download images from a channel |
| `/admindownloadmedia` | Bulk download media from a channel |
| `/eventadmin` | Event-scoped admin commands (list, seat, paid, reserve, unregister, regopen) |

### User Commands

| Command | Description |
|---------|-------------|
| `/register <event>` | Register for an event (includes edit flow for returning users) |
| `/unregister <event>` | Remove yourself from an event |
| `/status` | View upcoming events and your registration status |
