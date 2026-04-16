module.exports = {
  apps: [
    {
      name: "cartel-api",
      script: "server.js",
      restart_delay: 3000,
      max_restarts: 10,
      env: { NODE_ENV: "production" }
    },
    {
      name: "cartel-notifier",
      script: "whatsapp.js",
      restart_delay: 5000,
      max_restarts: 10,
      env: { NODE_ENV: "production" }
    }
  ]
};
