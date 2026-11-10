<?php
/*
 * Funcoes comuns de api/atualizar.php e api/status.php.
 *
 * Fazem o botao "Atualizar correntes" funcionar com o site aberto pelo XAMPP
 * (http://localhost/Trabalho-IA/). O PHP nao baixa nada sozinho: ele dispara o
 * atualizar_job.py em segundo plano (que roda o fetch_ocean.py) e le o
 * andamento em .atualizar_status.json.
 *
 * Requisitos (uma vez):
 *   - Python 3 instalado, com:  python -m pip install copernicusmarine numpy xarray
 *   - login no Copernicus:      copernicusmarine login
 *   - Apache iniciado pelo XAMPP Control Panel com o seu usuario do Windows
 *     (se rodar como servico, ele nao enxerga o seu Python nem o seu login).
 */

// Caminho do Python. Vazio = descobre sozinho.
// Se nao achar, coloque o caminho completo, por exemplo:
//   const PYTHON_PATH = 'C:\\Users\\SeuUsuario\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
const PYTHON_PATH = '';

define('ROOT_DIR', dirname(__DIR__));
define('STATUS_FILE', ROOT_DIR . DIRECTORY_SEPARATOR . '.atualizar_status.json');
define('LOCK_FILE', ROOT_DIR . DIRECTORY_SEPARATOR . '.atualizar.lock');
define('IS_WINDOWS', strncasecmp(PHP_OS, 'WIN', 3) === 0);

function responder($code, $dados)
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function ler_status()
{
    $txt = @file_get_contents(STATUS_FILE);
    $job = $txt ? json_decode($txt, true) : null;
    return is_array($job) ? $job : array('state' => 'idle', 'log' => array());
}

function gravar_status($job)
{
    $tmp = STATUS_FILE . '.tmp';
    file_put_contents($tmp, json_encode($job, JSON_UNESCAPED_UNICODE));
    @rename($tmp, STATUS_FILE) || (copy($tmp, STATUS_FILE) && @unlink($tmp));
}

function processo_vivo($pid)
{
    $pid = (int)$pid;
    if ($pid <= 0) return false;
    if (IS_WINDOWS) {
        $out = (string)@shell_exec('tasklist /FI "PID eq ' . $pid . '" /NH 2>NUL');
        return preg_match('/\b' . $pid . '\b/', $out) === 1;
    }
    $st = @file_get_contents('/proc/' . $pid . '/status');
    if ($st !== false) return !preg_match('/^State:\s*Z/m', $st); // zumbi = ja terminou
    if (function_exists('posix_kill')) return @posix_kill($pid, 0);
    return false;
}

/*
 * Corrige um status "running" que ficou para tras: o processo morreu
 * (PC reiniciado, janela fechada) ou o Python nem chegou a iniciar.
 */
function status_atual()
{
    $job = ler_status();
    if (($job['state'] ?? '') !== 'running') return $job;

    $desde = time() - (int)($job['started'] ?? 0);
    $pid = $job['pid'] ?? null;
    $erro = null;
    if ($pid === null && $desde > 60) {
        $erro = 'o Python nao iniciou. Confira o PYTHON_PATH em api/_atualizacao.php';
    } elseif ($pid !== null && !processo_vivo($pid)) {
        $erro = 'a atualizacao foi interrompida antes de terminar';
    }
    if ($erro) {
        $job['state'] = 'error';
        $job['finished'] = time();
        $job['log'][] = 'ERRO: ' . $erro;
        gravar_status($job);
    }
    return $job;
}

/*
 * Pergunta ao proprio Python se ha login salvo: e ele que vai usar o login,
 * entao enxerga a mesma pasta de usuario (o Apache nem sempre repassa HOME).
 */
function tem_login_copernicus($python)
{
    // so aspas simples aqui: no Windows o escapeshellarg troca aspas duplas por espaco
    $codigo = "import os,pathlib;print(int(bool(os.environ.get('COPERNICUSMARINE_SERVICE_USERNAME')) or "
            . "(pathlib.Path.home()/'.copernicusmarine'/'.copernicusmarine-credentials').is_file()))";
    $saida = @shell_exec(cmd_linha(array_merge($python, array('-c', $codigo))) . ' 2>&1');
    return trim((string)$saida) === '1';
}

/* Monta o comando como lista de partes ja protegidas para o shell. */
function cmd_linha($partes)
{
    return implode(' ', array_map('escapeshellarg', $partes));
}

/* Testa se o comando e um Python 3 de verdade (e nao o atalho da Microsoft Store). */
function python_ok($partes)
{
    $saida = @shell_exec(cmd_linha(array_merge($partes, array('-c', 'import sys;print(sys.version_info[0])'))) . ' 2>&1');
    return trim((string)$saida) === '3';
}

/* Retorna o Python como lista de partes, ex.: ['C:\...\python.exe'] ou ['py', '-3']; null se nao achar. */
function achar_python()
{
    $ds = DIRECTORY_SEPARATOR;
    $candidatos = array();
    if (PYTHON_PATH !== '') $candidatos[] = array(PYTHON_PATH);

    // ambiente virtual do proprio projeto
    $candidatos[] = array(ROOT_DIR . $ds . '.venv' . $ds . 'Scripts' . $ds . 'python.exe');
    $candidatos[] = array(ROOT_DIR . $ds . '.venv' . $ds . 'bin' . $ds . 'python');

    if (IS_WINDOWS) {
        foreach (array('python', 'py') as $nome) {
            $achados = preg_split('/\r?\n/', trim((string)@shell_exec('where ' . $nome . ' 2>NUL')));
            foreach ($achados as $c) {
                if ($c === '') continue;
                $candidatos[] = $nome === 'py' ? array($c, '-3') : array($c);
            }
        }
        $pastas = array(getenv('LOCALAPPDATA') . '\\Programs\\Python', getenv('ProgramFiles'), 'C:');
        foreach ($pastas as $p) {
            if (!$p) continue;
            $exes = glob($p . '\\Python3*\\python.exe') ?: array();
            rsort($exes, SORT_NATURAL); // versao mais nova primeiro
            foreach ($exes as $c) $candidatos[] = array($c);
        }
    } else {
        $candidatos[] = array('python3');
        $candidatos[] = array('python');
    }

    foreach ($candidatos as $c) {
        $exe = $c[0];
        $e_caminho = strpbrk($exe, '/\\') !== false;
        if ($e_caminho && !is_file($exe)) continue;
        if (python_ok($c)) return $c;
    }
    return null;
}

/* Dispara o atualizar_job.py sem esperar ele terminar. */
function iniciar_em_segundo_plano($partes)
{
    $linha = cmd_linha($partes);
    if (IS_WINDOWS) {
        // start /B: roda solto do Apache; a saida vai para NUL (o log fica no .json)
        pclose(popen('start "" /B ' . $linha . ' > NUL 2>&1', 'r'));
    } else {
        exec($linha . ' > /dev/null 2>&1 &');
    }
}
