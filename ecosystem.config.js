module.exports = {
    apps: [
      // ==========================================
      // DBC Service (Python gRPC)
      // ==========================================
      {
        name: 'dbc-service',
        script: 'python',
        args: 'src/main.py',
        cwd: '/var/www/evse-system/python-dbc-service',
        interpreter: '/var/www/.pyenv/versions/3.11.11/bin/python',
        env: {
          PYTHONUNBUFFERED: '1',
          PYTHONPATH: '/var/www/evse-system/python-dbc-service/src',
          GRPC_PORT: '50051',
          GRPC_HOST: '0.0.0.0',
          METRICS_PORT: '9091',
          LOG_LEVEL: 'info',
        },
        error_file: './logs/error.log',
        out_file: './logs/out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        autorestart: true,
        watch: false,
        max_memory_restart: '500M',
        instances: 1,
        exec_mode: 'fork'
      },
  
      // ==========================================
      // EVSE Device Service (NestJS)
      // ==========================================
      {
        name: 'evse-device-service',
        script: './dist/main.js',
        cwd: '/var/www/evse-system/evse-device-service',
        interpreter: 'node',
        env_file: '/var/www/evse-system/evse-device-service/.env',
        env: {
          NODE_ENV: 'production',
          PORT: '3001',
        },
        error_file: './logs/error.log',
        out_file: './logs/out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        autorestart: true,
        watch: false,
        max_memory_restart: '500M',
        instances: 1,
        exec_mode: 'cluster'
      }
    ]
  };