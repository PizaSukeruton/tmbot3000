// backend/services/tmCommandHandlers.js
const commandHandlers = {
  // Tour & Show Schedule
  show_schedule: (message, intent, member) => {
    return "I'm working on show schedule functionality. Try again later!";
  },
  
  venue_info: (message, intent, member) => {
    return "I'm working on venue info functionality. Try again later!";
  },

  setlist: (message, intent, member) => {
    return "I'm working on setlist functionality. Try again later!";
  },

  soundcheck: (message, intent, member) => {
    return "I'm working on soundcheck functionality. Try again later!";
  },
  
  travel_info: (message, intent, member) => {
    return "I'm working on travel info functionality. Try again later!";
  },

  production_notes: (message, intent, member) => {
    return "I'm working on production notes functionality. Try again later!";
  },

  production_info: (message, intent, member) => {
    return "I'm working on production information functionality. Try again later!";
  },

  amenities_info: (message, intent, member) => {
    return "I'm working on amenities info functionality. Try again later!";
  },

  personnel: (message, intent, member) => {
    return "I'm working on personnel information functionality. Try again later!";
  },
  
  access: (message, intent, member) => {
    return "I'm working on access info functionality. Try again later!";
  },

  media_info: (message, intent, member) => {
    return "I'm working on media info functionality. Try again later!";
  },

  merch_logistics: (message, intent, member) => {
    return "I'm working on merch logistics functionality. Try again later!";
  },

  history: (message, intent, member) => {
    return "I'm working on the chat history functionality. Try again later!";
  },
  
  help: () => {
    const commandList = `
**Here's a list of what I can help with:**

**Tour & Show Schedule** 🗓️
- **Show Schedule:** Find upcoming shows, set times, and other schedule details.
- **Venue Info:** Get details about venues, contacts, and amenities.
- **Production Info:** Get details on stage and production infrastructure.
- **Setlists:** Get the setlist for a specific show.
- **Soundcheck:** Get details on soundcheck and load-in times.
- **Travel Info:** Find information on travel, flights, and hotels.

**Day-to-Day Info** 📋
- **Personnel:** Get information about specific crew or band members.
- **Amenities:** Get details on day-to-day things like catering and laundry.
- **Access & Media:** Get info on guest lists, laminates, and press.

**System Commands**
- **History:** See a summary of our recent chat.
- **Help:** Show this menu.
`;
    return commandList;
  }
};
module.exports = commandHandlers;
