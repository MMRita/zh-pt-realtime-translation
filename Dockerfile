FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 5173
CMD ["node", "src/server.js"]
