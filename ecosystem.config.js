module.exports = {
  apps: [
    {
      name: 'LDbot2',
      script: 'app.js',
      node_args: '--max-old-space-size=4096',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
