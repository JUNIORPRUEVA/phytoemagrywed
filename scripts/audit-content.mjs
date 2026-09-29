/**
 * Auditoría de contenido (desarrollo): muestra las afirmaciones prohibidas
 * detectadas en la configuración. No forma parte del build.
 *   node scripts/audit-content.mjs
 */
import { contentConfig } from '../src/config/content.config.js';
import { productConfig } from '../src/config/product.config.js';
import { siteConfig } from '../src/config/site.config.js';
import { auditConfigs } from '../src/lib/content-safety.js';

const violations = auditConfigs({ site: siteConfig, product: productConfig, content: contentConfig });

if (violations.length === 0) {
  console.log('✅ Sin afirmaciones prohibidas en la configuración.');
} else {
  console.log(`⚠️  ${violations.length} posible(s) afirmación(es) prohibida(s):`);
  for (const item of violations) {
    console.log(`  - [${item.id}] ${item.label}`);
    console.log(`    ${item.path}`);
    console.log(`    "${item.excerpt}"`);
  }
}
