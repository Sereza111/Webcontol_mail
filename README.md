# 📧 Beget Mail Generator

Веб-панель для автоматической генерации почтовых ящиков на хостинге Beget.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![Express](https://img.shields.io/badge/Express.js-4.x-blue?logo=express)
![Bootstrap](https://img.shields.io/badge/Bootstrap-5.3-purple?logo=bootstrap)
![SQLite](https://img.shields.io/badge/SQLite-3-blue?logo=sqlite)

## 🚀 Возможности

- ✅ Автогенерация случайных имён и паролей для почтовых ящиков
- ✅ Интеграция с Beget API
- ✅ Хранение данных в локальной SQLite базе
- ✅ Экспорт в формате `email:password`
- ✅ Современный адаптивный интерфейс на Bootstrap 5
- ✅ Массовое создание и удаление ящиков
- ✅ Копирование данных в буфер обмена

## 📋 Требования

- Node.js 18+ 
- npm или yarn
- Аккаунт на Beget с API доступом
- Домен, привязанный к Beget

## 🛠️ Локальная установка

### 1. Клонирование репозитория

```bash
git clone https://github.com/Sereza111/Webcontol_mail.git
cd Webcontol_mail
```

### 2. Установка зависимостей

```bash
npm install
```

### 3. Настройка конфигурации

Скопируйте файл `.env.example` в `.env`:

```bash
cp .env.example .env
```

Отредактируйте `.env` файл:

```env
# Beget API Credentials
BEGET_LOGIN=ваш_логин_beget
BEGET_PASSWORD=ваш_api_пароль_beget

# Server Configuration
PORT=3000
HOST=localhost
```

> ⚠️ **Важно:** API пароль Beget отличается от пароля входа в панель! 
> Получить API пароль можно в панели Beget: Настройки → API

### 4. Запуск

```bash
npm start
```

Откройте в браузере: http://localhost:3000

---

## 🖥️ Развёртывание на сервере

### Вариант 1: Запуск с PM2 (рекомендуется)

PM2 - менеджер процессов для Node.js, который обеспечивает автоматический перезапуск и мониторинг.

```bash
# Установка PM2 глобально
npm install -g pm2

# Клонирование репозитория
git clone https://github.com/Sereza111/Webcontol_mail.git
cd Webcontol_mail

# Установка зависимостей
npm install

# Настройка .env
cp .env.example .env
nano .env  # Введите ваши данные Beget

# Запуск через PM2
pm2 start app.js --name "beget-mail"

# Автозапуск при перезагрузке сервера
pm2 startup
pm2 save

# Просмотр логов
pm2 logs beget-mail

# Статус приложения
pm2 status
```

### Вариант 2: Запуск через systemd (Linux)

Создайте файл сервиса:

```bash
sudo nano /etc/systemd/system/beget-mail.service
```

Содержимое файла:

```ini
[Unit]
Description=Beget Mail Generator
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/Webcontol_mail
ExecStart=/usr/bin/node app.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Запуск сервиса:

```bash
# Перезагрузка демонов
sudo systemctl daemon-reload

# Включение автозапуска
sudo systemctl enable beget-mail

# Запуск
sudo systemctl start beget-mail

# Проверка статуса
sudo systemctl status beget-mail

# Просмотр логов
sudo journalctl -u beget-mail -f
```

### Вариант 3: Docker

Создайте `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "app.js"]
```

Запуск:

```bash
# Сборка образа
docker build -t beget-mail .

# Запуск контейнера
docker run -d \
  --name beget-mail \
  -p 3000:3000 \
  -e BEGET_LOGIN=your_login \
  -e BEGET_PASSWORD=your_api_password \
  -v beget-mail-data:/app \
  beget-mail
```

---

## 🌐 Настройка Nginx (reverse proxy)

Для доступа по домену настройте Nginx:

```nginx
server {
    listen 80;
    server_name mail.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Применение конфигурации:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### SSL сертификат (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d mail.yourdomain.com
```

---

## 📁 Структура проекта

```
Webcontol_mail/
├── app.js              # Основной сервер Express.js
├── package.json        # Зависимости проекта
├── .env                # Конфигурация (создать из .env.example)
├── .env.example        # Пример конфигурации
├── .gitignore          # Игнорируемые файлы Git
├── mailboxes.db        # SQLite база данных (создаётся автоматически)
├── public/
│   ├── index.html      # Главная страница
│   ├── styles.css      # Стили
│   └── app.js          # Клиентский JavaScript
└── README.md           # Документация
```

---

## 🔌 API Endpoints

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/domains` | Список доменов из Beget |
| GET | `/api/mailboxes/:domain` | Почтовые ящики домена (Beget) |
| GET | `/api/local-mailboxes` | Локальные ящики из SQLite |
| POST | `/api/generate` | Генерация новых ящиков |
| DELETE | `/api/mailbox` | Удаление ящика |
| POST | `/api/mailboxes/delete-multiple` | Массовое удаление |
| GET | `/api/export` | Экспорт в формате email:password |
| GET | `/api/check-connection` | Проверка соединения с API |

---

## 🔧 Получение API пароля Beget

1. Войдите в [панель управления Beget](https://cp.beget.com)
2. Перейдите в **Настройки** → **API**
3. Включите API доступ
4. Скопируйте API пароль (он отличается от пароля входа!)
5. Добавьте IP сервера в белый список (если требуется)

---

## ⚠️ Безопасность

- 🔒 Никогда не коммитьте файл `.env` в репозиторий
- 🔒 Используйте HTTPS в production
- 🔒 Ограничьте доступ по IP или добавьте авторизацию
- 🔒 Регулярно обновляйте зависимости: `npm audit fix`

---

## 📝 Лицензия

MIT License - свободное использование и модификация.

---

## 🤝 Автор

Создано с ❤️ для автоматизации работы с почтой Beget.

**GitHub:** [Sereza111](https://github.com/Sereza111)
