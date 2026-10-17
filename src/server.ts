import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Express, type Request, type Response } from 'express';
import ts from 'typescript';
import { errorHandler, notFoundHandler } from './api/error-handler';
import { createRoutes } from './api/routes';
import { openDatabase } from './db/database';
import { seedIfEmpty } from './db/seed';
import { BillingService } from './services/billing-service';

let cachedAppJs: string | null = null;

/**
 * The dashboard script has no build step of its own: src/public/app.ts is
 * transpiled on demand and cached in production (dev keeps hot reloads).
 */
function compileAppJs(): string {
  if (process.env.NODE_ENV === 'production' && cachedAppJs !== null) {
    return cachedAppJs;
  }
  const source = readFileSync(join(__dirname, 'public', 'app.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
    },
  });
  if (process.env.NODE_ENV === 'production') {
    cachedAppJs = outputText;
  }
  return outputText;
}

export function createApp(db: DatabaseSync): Express {
  const service = new BillingService(db);
  const app = express();

  app.use(express.json());
  app.use(createRoutes(service));
  app.use(express.static(join(__dirname, 'public')));
  app.get('/app.js', (_req: Request, res: Response) => {
    res.type('application/javascript');
    res.send(compileAppJs());
  });

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  const db = openDatabase();
  seedIfEmpty(db);
  const port = Number(process.env.PORT) || 3000;
  const server = createApp(db).listen(port, () => {
    console.log(`Faro ledger API and dashboard on http://localhost:${port}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
