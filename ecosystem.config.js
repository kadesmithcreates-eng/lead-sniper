module.exports = {
  apps: [
    {
      name: 'fb-monitor',
      script: 'src/monitor.js',
      restart_delay: 10000,
      max_restarts: 20,
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'fb-dashboard',
      script: 'src/server.js',
      restart_delay: 3000,
      max_restarts: 20,
      env: { NODE_ENV: 'production' }
    }
  ]
};
