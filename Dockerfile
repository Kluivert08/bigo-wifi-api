# Utilisation d'une image légère
FROM node:20-bookworm-slim as base

# Environnement de production
ENV NODE_ENV="production"
WORKDIR /app

# --- Étape de Build ---
FROM base as build

# Installation des dépendances système nécessaires pour compiler des modules Node
RUN apt-get update -qq && \
    export DEBIAN_FRONTEND=noninteractive && \
    apt-get install --no-install-recommends -y \
    build-essential \
    node-gyp \
    pkg-config \
    python-is-python3 \
    python3-dev && \
    rm -rf /var/lib/apt/lists/*

# Installation des dépendances de l'application
# On ne copie que le package.json car vous n'avez pas de lockfile
COPY package.json ./
RUN npm install --include=dev

# Copie du reste du code source
COPY . .

# --- Étape Finale ---
FROM base

# Copie uniquement le dossier de l'application depuis l'étape de build
COPY --from=build /app /app

# Exposition du port (doit correspondre à fly.toml)
EXPOSE 8080

# Commande de démarrage
CMD [ "npm", "run", "start" ]
