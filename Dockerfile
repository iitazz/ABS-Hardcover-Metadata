FROM node:22-alpine
WORKDIR /app
COPY server.js .
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
RUN mkdir /data && chown node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
