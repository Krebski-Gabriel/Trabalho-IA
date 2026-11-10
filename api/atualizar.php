<?php
/*
 * POST api/atualizar.php  — inicia a atualizacao das correntes (Copernicus).
 * Mesmas respostas do /api/atualizar do servidor.py:
 *   202 iniciou · 409 ja esta atualizando · 428 falta login · 500 sem Python
 * Corpo opcional (JSON): {"date": "YYYY-MM-DD", "noSst": true}
 */
require __DIR__ . '/_atualizacao.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    responder(405, array('erro' => 'use POST'));
}

$opt = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($opt)) $opt = array();

// trava: dois cliques ao mesmo tempo nao disparam duas atualizacoes
$lock = fopen(LOCK_FILE, 'c');
if (!$lock || !flock($lock, LOCK_EX)) {
    responder(500, array('erro' => 'nao consegui gravar na pasta do projeto (permissao)'));
}

if ((status_atual()['state'] ?? '') === 'running') {
    responder(409, array('erro' => 'ja esta atualizando'));
}
$python = achar_python();
if (!$python) {
    responder(500, array('erro' => "Python nao encontrado.\nInstale o Python 3 ou ajuste o PYTHON_PATH em api/_atualizacao.php"));
}
if (!tem_login_copernicus($python)) {
    responder(428, array('erro' => "faca login uma vez no terminal:\n  copernicusmarine login"));
}

$partes = array_merge($python, array(ROOT_DIR . DIRECTORY_SEPARATOR . 'atualizar_job.py'));
if (!empty($opt['date']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', substr((string)$opt['date'], 0, 10))) {
    $partes[] = '--date';
    $partes[] = substr((string)$opt['date'], 0, 10);
}
if (!empty($opt['noSst'])) $partes[] = '--no-sst';

// marca "running" antes de disparar: o job sobrescreve com o pid assim que sobe
gravar_status(array(
    'state' => 'running',
    'log' => array('iniciando o Python...'),
    'started' => time(),
    'finished' => null,
    'rc' => null,
    'pid' => null,
));
iniciar_em_segundo_plano($partes);

flock($lock, LOCK_UN);
fclose($lock);
responder(202, array('ok' => true));
