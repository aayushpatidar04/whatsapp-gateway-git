module.exports = {
    apps: [
        {
            name:        'whatsapp-gateway',
            script:      './src/index.js',
            interpreter: 'node',
            instances:   1,          // MUST be 1 — single WhatsApp session per process
            exec_mode:   'fork',
            watch:       false,
            max_memory_restart: '400M',

            // Explicitly pass env vars (PM2 doesn't auto-load .env)
            env: {
                NODE_ENV:                 'production',
                PORT:                     '3000',
                // CRM_URL:                  'http://127.0.1:8000',
                CRM_URL:                  'https://crm.arihantcapital.com',
                GATEWAY_SECRET:           'aayush-patidar',
                GATEWAY_UI_USER:          'admin@intouchconnect.com',
                GATEWAY_UI_PASSWORD:      'Aayush@123',
                GATEWAY_SESSION_SECRET:   'aayush-patidar',
                LOG_LEVEL:                'info',
            },

            error_file:      './logs/pm2-error.log',
            out_file:        './logs/pm2-out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',

            autorestart:   true,
            max_restarts:  50,
            min_uptime:    '5s',
            restart_delay: 3000,
        },
    ],
};
