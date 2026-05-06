const http = require("http");

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Hola mundo</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            font-family: sans-serif;
            background: #f5f7fb;
          }
          h1 {
            color: #1d3557;
            font-size: 2rem;
          }
        </style>
      </head>
      <body>
        <h1>Hola mundo</h1>
      </body>
    </html>
  `);
});

server.listen(port, () => {
  console.log(`Servidor activo en http://localhost:${port}`);
});
