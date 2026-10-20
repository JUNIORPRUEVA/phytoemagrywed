# Perfil FULLTECH en WhatsApp Business

El proyecto incluye el logo de FULLTECH en `public/admin/fulltech-logo.png`.
El comando siguiente actualiza la descripción (`about`) y la foto del perfil de
WhatsApp Cloud API con ese logo. Primero muestra una vista previa; solo contacta
y modifica Meta al pasar `--apply`.

Requiere `META_APP_ID`, `WHATSAPP_PHONE_NUMBER_ID` y
`WHATSAPP_ACCESS_TOKEN` con permiso `whatsapp_business_management`. Se pueden
definir en el entorno o en un archivo local protegido, por ejemplo `.env` (no se
versiona):

```powershell
npm run configure:fulltech-whatsapp-profile -- --env-file .env
npm run configure:fulltech-whatsapp-profile -- --env-file .env --apply
```

Para solicitar el cambio del nombre visible por Graph API:

```powershell
npm run configure:fulltech-whatsapp-profile -- --env-file .env --request-display-name
npm run configure:fulltech-whatsapp-profile -- --env-file .env --request-display-name --apply
```

La descripción configurada es: “Tecnología, ventas y servicio a buen precio,
con atención cercana y entrega ágil.”

La solicitud por API no fuerza la aprobación. Meta revisa el nombre; se
recomienda usar un nombre que pueda relacionarse con la documentación y
presencia pública del negocio. Cuando Meta apruebe un nombre nuevo, su guía
indica que hay que registrar de nuevo el número para activarlo.
