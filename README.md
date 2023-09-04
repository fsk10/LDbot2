# LDbot2 - Discord Bot

LDbot2 is a Discord bot designed for managing and organizing events. 

**Disclaimer:** 
This bot was developed for a specific, personal project and is made public for reference purposes only. The repository does not offer support, guarantees, or warranties for its functionality outside of its original intent. If you choose to utilize or modify the code, do so at your own risk.

## Features *(In-progress)*
**Legend**:

:white_check_mark: Completed :construction: In-Progress :calendar: Planned

- **Slash Commands**: Utilizes Discord's slash command feature for intuitive and easy command execution.


- **Admin Management**:
  - **Settings** 
    * :white_check_mark: **Simple Permissions System**: Define an admin-role for full bot admin permissions. 
    * :white_check_mark: **Logging**: Logging of bot activities and interactions to defined logging-channel.
  - **Events**
    * :white_check_mark: **Create events**
    * :construction: **Edit events**
    * :white_check_mark: **Delete event**
    * :white_check_mark: **List events**
    * :calendar: **Event Status Updates**: Generate dynamic event participation-list in defined event-channel.
    * :calendar: **Notifications**: Send out notifications for upcoming events & registration info.
  - **Users**
  	* :white_check_mark: Add users to events
    * :construction: Edit user details
    * :white_check_mark: Remove users from events
    * :white_check_mark: List users in events


- **User Commands**:
	* :calendar: Registration: *Commands for users to register and unregister to events*


## Prerequisites *(In-progress)*
* **Node.js (tested on v20.5.1)**: <br>The bot runs on Node.js. You need to have it installed to run the bot. If you haven't installed it yet, download and install it from <a href="https://nodejs.org/en">Node.js official website</a>.


## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/fsk10/LDbot2.git
    ```
2. Navigate to the project directory:
   ```bash
   cd LDbot2
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Set up the bot in the discord developer portal.<br>
Here is a good guide from the <a href="https://discordjs.guide/preparations/setting-up-a-bot-application.html">discord.js website</a>

   
5. Create a config.json file in the root directory of the bot and configure BOT_TOKEN, SERVER_ID (GUILD), CLIENT_ID (APPLICATION ID) and the BOT OWNER ID:
   ```bash
   {
    "BOT_TOKEN":	"",
    "SERVER_ID":	"",
    "CLIENT_ID":    "",
    "BOT_OWNER_ID":	"" 
   }
   ```
6. Run the bot:
   ```bash
   node app.js
   ```
   
## Usage *(In-progress)*

| Command | Description | Example |
| ------- | ----------- | ------- |
| `/command1` | Description1 | `/command1 <subcommand> <value>` |
| `/command2` | Description2 | `/command2 <subcommand> <value>` |
| ...      | ...         | ...     |
