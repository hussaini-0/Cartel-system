// Notifications are handled by whatsapp.js listening to socket events.
// This module is kept as a no-op so existing imports do not break.
async function sendOrderUpdate() {}

module.exports = { sendOrderUpdate };
