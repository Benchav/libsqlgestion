import { createClient } from "@libsql/client";

const client = createClient({
  url: "https://insbarrera-1ac07590.ibarrera.site",
  authToken: "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.e30.QSlKTcDWZhgBFEV5AAAdDAUvyxc0CcH-CVk1xds2K_a3l8xR9NMPoA67lOOQNT0iLcN6crzt__YDZXpITlegCg"
});

async function test() {
  console.log("Intentando conectar a la nueva base de datos...");
  try {
    const rs = await client.execute("SELECT '¡Funciona a la perfección!' AS mensaje");
    console.log("Resultado de la consulta:", rs.rows);
  } catch (error) {
    console.error("Falló la conexión:", error.message);
  }
}

test();
