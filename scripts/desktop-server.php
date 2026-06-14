<?php

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Unable to resolve Wallos project root.\n");
    exit(1);
}

chdir($root);
putenv('WALLOS_DESKTOP_APP=1');

require_once $root . '/endpoints/cronjobs/createdatabase.php';
require_once $root . '/endpoints/db/migrate.php';

$host = getenv('WALLOS_DESKTOP_HOST') ?: '127.0.0.1';
$port = getenv('WALLOS_DESKTOP_PORT') ?: '8787';
$dbFile = getenv('WALLOS_DB_FILE');

$environment = 'WALLOS_DESKTOP_APP=1';
if ($dbFile !== false && $dbFile !== '') {
    $environment .= ' WALLOS_DB_FILE=' . escapeshellarg($dbFile);
}

$command = sprintf(
    '%s php -S %s:%s -t %s',
    $environment,
    escapeshellarg($host),
    escapeshellarg($port),
    escapeshellarg($root)
);

passthru($command, $exitCode);
exit($exitCode);
