module.exports = {
  apps: [
    {
      name: 'music-pusher',
      script: 'server/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
