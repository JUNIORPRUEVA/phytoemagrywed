// Se registra con un nombre nuevo; Meta conserva el texto de las anteriores.
export const FULLTECH_CONTACT_TEMPLATE = Object.freeze({
    // Nueva identidad: conserva intactas las plantillas ya aprobadas en Meta.
    name: 'fulltech_contacto_personalizado_v2',
    friendly_name: 'Contacto personalizado · FullTECH',
    group: 'SEGUIMIENTO',
    category: 'MARKETING',
    language: 'es',
    body: 'Hola, {{1}}. Te escribimos de FullTECH.\n\n{{2}}\n\nQuedo atento a tu respuesta.',
    variables: ['customer_name', 'mensaje'],
    buttons: [],
  });
