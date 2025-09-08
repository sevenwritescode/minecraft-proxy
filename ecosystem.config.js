module.exports = {
  apps: [
    {
      name: "mc-proxy",
      script: "./mc-proxy-ec2.js",
      args: "",
      // run with a single instance (it's network I/O)
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
      // env vars (override by .env/dotenv)
      env_production: {
        NODE_ENV: "production",
        // you can put non-secret defaults here; prefer .env or OS env for AWS secrets
      }
    }
  ]
}