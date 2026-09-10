FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY src/sandbox-worker.mjs ./sandbox-worker.mjs
USER pwuser
CMD ["node", "--max-old-space-size=256", "sandbox-worker.mjs"]
