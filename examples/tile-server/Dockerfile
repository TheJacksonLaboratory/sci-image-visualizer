# Lightweight tile server for the sci-image-visualizer browser example.
# sharp bundles prebuilt libvips (no OpenSlide needed — it reads the *converted*
# pyramided COGs, not raw SVS/NDPI; conversion is done offline by make-cog.mjs).
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
COPY lib ./lib
# COGs are provided at runtime: either baked into the image, mounted, or synced
# from a bucket into $COG_DIR on startup (see README "Deploy").
ENV PORT=8080
ENV COG_DIR=/app/cogs
EXPOSE 8080
CMD ["node", "server.mjs"]
