<?php
/*
 * GET api/status.php — andamento da atualizacao das correntes.
 * Mesmo formato do /api/status do servidor.py: {state, log, started, finished, rc}
 */
require __DIR__ . '/_atualizacao.php';

$job = status_atual();
unset($job['pid']);
responder(200, $job);
