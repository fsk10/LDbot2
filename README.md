# LDbot2 - Discord Bot

LDbot2 is a Discord bot designed for managing and organizing events. 

**Disclaimer:** 
This bot was developed for a specific, personal project and is made public for reference purposes only. The repository does not offer support, guarantees, or warranties for its functionality outside of its original intent. If you choose to utilize or modify the code, do so at your own risk.

## Features
**Legend**:

:white_check_mark: Completed :construction: In-Progress :calendar: Planned

- **Slash Commands**: Utilizes Discord's slash command feature for intuitive and easy command execution.


- **Admin Management**:
  - **Settings** 
    * :white_check_mark: **Simple Permissions System:** Define an admin-role for full bot admin permissions. 
    * :white_check_mark: **Logging:** Logging of bot activities and interactions to defined logging-channel.
  - **Events**
    * :white_check_mark: **Create events**
    * :white_check_mark: **Edit events**
    * :white_check_mark: **Delete event**
    * :white_check_mark: **List events**
    * :calendar: **Notifications:** Send out notifications for upcoming events & registration info.
  - **Users**
  	* :white_check_mark: **Add users to events**
  	  * :white_check_mark: **Dynamic participantslist:** Generate dynamic event participants-list in defined event-channel.
  	  * :white_check_mark: **Dynamic seating map:** Generate dynamic seating map in the participants channel and during user seat registration.
  	  * :calendar: **Reserves list:** Add users to an event reserveslist when participant seat limit is reached.
    * :white_check_mark: **Edit user details**
    * :white_check_mark: **Remove users from events**
    * :white_check_mark: **List users in events**


- **User Commands**:
	* :white_check_mark: **Register for event:** *Command for users to signup to events*
	* :white_check_mark: **Edit registration:** *Functionality for users to edit their own user and event registration details (built into the register command)*
	* :calendar: **Unregister from event:** *Command for users to leave/remove themselves from an event*


#
### Installation

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
4. Set up the bot in the discord developer portal:
   https://discordjs.guide/preparations/setting-up-a-bot-application.html
   
5. Create a config.json file in the root directory and add BOT_TOKEN, SERVER_ID (GUILD), CLIENT_ID (APPLICATION ID) and the BOT OWNER ID:
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
#   
### Usage *(In-progress)*

| Command | Description | Example |
| ------- | ----------- | ------- |
| `/adminget <setting>` | .... | `....` |
| `/adminset <setting> <value>` | .... | `....` |
| `/adminadd <event|user>` | .... | `....` |
| `/adminedit <event|user|eventuser>` | .... | `....` |
| `/admindel <event|user>` | .... | `....` |
| `/adminlist <events|users>` | .... | `....` |
| `/register <event>` | .... | `....` |
| ....      | ....         | ....     |
