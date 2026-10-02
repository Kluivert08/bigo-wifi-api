# Image Node.js 22 officielle (avec support natif des WebSockets pour Supabase)
FROM node:22-bookworm-slim

ENV NODE_ENV="production"
WORKDIR /app

# Copie du descripteur de paquets
COPY package.json ./

# Installation des dépendances de production uniquement
RUN npm install --omit=dev

# Copie du code source
COPY . .

# Exposition du port
EXPOSE 8080

# Démarrage de l'API
CMD [ "npm", "start" ]
