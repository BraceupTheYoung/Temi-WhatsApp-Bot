FROM node:22-slim

WORKDIR /app

# No browser needed anymore (Meta Cloud API transport) — plain npm install.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "teacher-bot.js"]
