# Plantilla para compartir una ubicación con otro número

Fuera de la ventana de 24 h WhatsApp **no deja** mandar ubicaciones ni texto libre: solo
plantillas aprobadas. Esta es la plantilla propia del CRM para ese caso.

## Datos para crearla en WhatsApp Manager

| Campo | Valor |
| --- | --- |
| Nombre | `phyto_compartir_ubicacion_v1` |
| Categoría | **Utility** (utilidad) |
| Idioma | Español (`es`) |
| Tipo | Texto, sin cabecera ni pie |

### Cuerpo (copiar tal cual)

```
Hola {{1}}, te compartimos la ubicación de {{2}} para la entrega.

Dirección: {{3}}
Mapa: {{4}}

Cualquier cosa nos dices.
```

### Ejemplos que pide Meta al crearla

| Variable | Ejemplo |
| --- | --- |
| `{{1}}` | Pedro (a quién se le manda) |
| `{{2}}` | Yahaira Rodríguez (de quién es el punto) |
| `{{3}}` | Calle Duarte 12, Santo Domingo |
| `{{4}}` | https://www.google.com/maps?q=18.48610,-69.93120 |

## Qué hace el CRM con ella

1. En el chat, abrir la ubicación → **Compartir** → elegir el destinatario.
2. Si la ventana de 24 h del destinatario está abierta, se manda la ubicación **nativa**
   de WhatsApp (el mapa dentro del chat).
3. Si está cerrada, el panel ofrece **«Enviar por plantilla»** y el servidor usa
   `phyto_compartir_ubicacion_v1` con los cuatro datos en orden.
4. Si esa plantilla aún no está aprobada, se intenta una plantilla con hueco de texto
   libre; si tampoco hay, se explica en pantalla y **no se envía nada**.

El mensaje queda en el hilo del destinatario con el punto guardado, y la auditoría
registra el modo (`location` o `template`) sin escribir coordenadas.

## Después de crearla

Ajustes → **Sincronizar con Meta** (o esperar a la sincronización automática). La
plantilla aparece aprobada y el botón «Enviar por plantilla» deja de fallar.
