import { createClient } from "@libsql/client";

const client = createClient({
  url: "https://tu-database",
  authToken: "tu-auth-token"
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
