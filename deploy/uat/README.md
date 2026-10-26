# UAT en la nube — FULLTECH DELIVERY / CRM

Servicio **independiente** para probar la app Android contra un backend de UAT
con HTTPS válido. Reutiliza el mismo backend del CRM: no duplica lógica de negocio.

## Qué queda aislado

| Pieza | Producción | UAT |
| --- | --- | --- |
| Servicio | `crm` (prod) | `crm` de este compose |
| Base de datos | Postgres de prod | contenedor `db` propio, **sin puerto publicado** |
| Credenciales | las de prod | nuevas, generadas para UAT |
| Almacenamiento | bucket prod | bucket/carpeta UAT (o ninguno) |
| WhatsApp / Meta | reales | **vacías** (el CRM se desactiva solo) |
| Datos | reales | sintéticos |

## Pasos (requieren autorización del propietario)

1. Copiar la plantilla y rellenar **sin reutilizar** ninguna credencial:
   `cp deploy/uat/.env.uat.example deploy/uat/.env.uat`
2. Generar secretos nuevos (token del panel, clave de admin, clave de Postgres).
3. Levantar: `docker compose -f deploy/uat/docker-compose.uat.yml --env-file deploy/uat/.env.uat up -d --build`
4. Comprobar salud: `curl -fsS https://<dominio-uat>/api/health`
5. En el panel de la plataforma, apuntar el dominio UAT al servicio `crm`, puerto
   `8080`. El TLS lo emite el ingress (Let's Encrypt del panel); no se instala
   ningún certificado autofirmado en la nube.
6. Alta de datos de prueba: empresas (`logistics_companies`) y un repartidor con
   concesión. Nada de cuentas reales.

## Verificación después de arrancar

- `/api/health` responde 200 sin datos personales.
- `GET /api/courier/companies` devuelve las empresas de UAT.
- Un repartidor de prueba hace login y ve **solo** su empresa.
- La base de datos **no** es alcanzable desde fuera de la red del compose.
- Los logs no muestran tokens ni teléfonos completos.

## Rollback

- `docker compose -f deploy/uat/docker-compose.uat.yml down` (conserva el volumen).
- Para volver a una imagen anterior: `docker compose ... up -d --no-deps --build crm`
  con el commit previo, o `docker service rollback` si se desplegó como servicio.
- Los datos de UAT se pueden descartar: `down -v` borra el volumen de pruebas.

## Lo que este paquete NO hace

- No despliega nada por sí solo.
- No crea el DNS ni el certificado: los da la plataforma al conectar el dominio.
- No toca el servicio ni la base de producción.
- No envía WhatsApp real ni eventos a Meta.

## Paso que falta para el APK de nube

Cuando exista el dominio UAT con certificado válido, compilar sin tocar código:

```powershell
flutter build apk --release `
  --dart-define=DELIVERY_ENV=production `
  --dart-define=DELIVERY_API_BASE_URL=https://<dominio-uat> `
  --dart-define=DELIVERY_DEMO_DATA=false
```

Ese APK ya usa la clave de release real (`android/key.properties`) y **no** carga
ninguna CA local: confía solo en las raíces del sistema.
