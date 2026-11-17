# Roger server. (render.yaml runs it with Render's own Node runtime; this file is for any other host that uses Docker.)
FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
# run as the unprivileged "node" user, not root
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]