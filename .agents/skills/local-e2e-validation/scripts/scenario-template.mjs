export const name = 'replace-with-scenario-name';
export const contract = {
  requiredPhases: ['setup', 'baseline', 'trigger', 'broken-state', 'recovery', 'confirmation'],
};

export default async function scenario(e2e) {
  const appEnv = {
    APP_DATA_DIR: e2e.dataDir,
    APP_ENV: 'test',
  };

  await e2e.phase('setup', async () => {
    // Build or copy immutable runtime artifacts. Start real services with e2e.start().
    // Wait for actual readiness with e2e.waitForLog(), e2e.waitFor(), or e2e.requestHttp().
    await e2e.check('isolated topology is ready', () => {
      throw new Error('replace with a deterministic assertion');
    });
  });

  await e2e.phase('baseline', async () => {
    // Perform and assert the real public operation before failure injection.
    await e2e.check('baseline public operation', () => {
      throw new Error('replace with a deterministic assertion');
    });
  });

  await e2e.phase('trigger', async () => {
    // Reproduce the reported sequence through deterministic script actions.
    await e2e.check('failure trigger completed', () => {
      throw new Error('replace with a deterministic assertion');
    });
  });

  await e2e.phase('broken-state', async () => {
    // Assert the first broken boundary and every coupled state.
    await e2e.check('reported failure is reproduced', () => {
      throw new Error('replace with a deterministic assertion');
    });
  });

  await e2e.phase('recovery', async () => {
    // Invoke the production recovery path and wait for its settled state.
    await e2e.check('recovery settles all coupled state', () => {
      throw new Error('replace with a deterministic assertion');
    });
  });

  await e2e.phase('confirmation', async () => {
    // Repeat the original public operation and one adjacent lifecycle transition.
    await e2e.check('original operation succeeds after recovery', () => {
      throw new Error('replace with a deterministic assertion');
    });
  });

  void appEnv;
}
