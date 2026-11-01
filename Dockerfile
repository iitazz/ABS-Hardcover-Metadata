FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY server.js entrypoint.sh ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
RUN mkdir /data && chown node /data
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server.js"]
