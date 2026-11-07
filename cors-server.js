const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const HOST = '0.0.0.0';

const server = http.createServer((req, res) => {
    console.log(`\n📥 Входящий запрос: [${req.method}] ${req.url}`);

    // Разрешаем CORS для всех запросов
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // 1. Отвечаем на OPTIONS (preflight)
    if (req.method === 'OPTIONS') {
        console.log('✅ Отправлен ответ на OPTIONS (204)');
        res.writeHead(204);
        res.end();
        return;
    }

    // 2. Обрабатываем GET и HEAD запросы
    if (req.method === 'GET' || req.method === 'HEAD') {
        const filePath = path.join(__dirname, 'Index.js');
        
        // Сначала проверяем, существует ли файл и получаем его размер
        fs.stat(filePath, (err, stats) => {
            if (err) {
                console.error('❌ Ошибка: файл Index.js не найден');
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
                return;
            }
            
            console.log(`✅ УСПЕХ: Файл найден (${stats.size} bytes). Метод: ${req.method}`);
            
            // Отдаем заголовки с правильным Content-Type и размером
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Content-Length': stats.size
            });

            // Если это GET, отдаем содержимое файла. Если HEAD — только заголовки.
            if (req.method === 'GET') {
                fs.createReadStream(filePath).pipe(res);
            } else {
                res.end();
            }
        });
    } else {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
    }
});

server.listen(PORT, HOST, () => {
    console.log('\n==================================================');
    console.log('✅ Сервер готов и поддерживает HEAD-запросы!');
    console.log(`📱 URL для Lampa: http://${HOST}:${PORT}/Index.js`);
    console.log('==================================================\n');
});
