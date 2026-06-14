<?php

function wallos_is_desktop_app()
{
    return getenv('WALLOS_DESKTOP_APP') === '1';
}

function wallos_prepare_desktop_storage()
{
    if (!file_exists('images/uploads/logos')) {
        mkdir('images/uploads/logos', 0777, true);
    }

    if (!file_exists('images/uploads/logos/avatars')) {
        mkdir('images/uploads/logos/avatars', 0777, true);
    }
}

function wallos_column_exists($db, $table, $column)
{
    $safeTable = str_replace("'", "''", $table);
    $stmt = $db->prepare("SELECT 1 FROM pragma_table_info('$safeTable') WHERE name = :column");
    $stmt->bindValue(':column', $column, SQLITE3_TEXT);
    $result = $stmt->execute();

    return $result->fetchArray(SQLITE3_ASSOC) !== false;
}

function wallos_ensure_desktop_admin($db)
{
    if (!wallos_is_desktop_app()) {
        return null;
    }

    wallos_prepare_desktop_storage();

    $user = $db->query("SELECT * FROM user WHERE id = 1")->fetchArray(SQLITE3_ASSOC);

    if ($user === false) {
        $stmt = $db->prepare(
            "INSERT INTO user (id, username, firstname, lastname, email, password, main_currency, avatar, language, budget, api_key)
             VALUES (1, 'desktop', 'Desktop', 'User', 'desktop@wallos.local', :password, 2, 'images/avatars/0.svg', 'zh_cn', 0, :api_key)"
        );
        $stmt->bindValue(':password', password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT), SQLITE3_TEXT);
        $stmt->bindValue(':api_key', bin2hex(random_bytes(32)), SQLITE3_TEXT);
        $stmt->execute();

        $user = $db->query("SELECT * FROM user WHERE id = 1")->fetchArray(SQLITE3_ASSOC);
    }

    if ($user === false) {
        return null;
    }

    if (($user['language'] ?? '') !== 'zh_cn') {
        $db->exec("UPDATE user SET language = 'zh_cn' WHERE id = 1");
        $user['language'] = 'zh_cn';
    }

    $stmt = $db->prepare("SELECT COUNT(*) FROM household WHERE user_id = 1");
    $householdCount = (int) $stmt->execute()->fetchArray(SQLITE3_NUM)[0];
    if ($householdCount === 0) {
        $db->exec("INSERT INTO household (name, user_id) VALUES ('desktop', 1)");
    }

    $stmt = $db->prepare("SELECT COUNT(*) FROM settings WHERE user_id = 1");
    $settingsCount = (int) $stmt->execute()->fetchArray(SQLITE3_NUM)[0];
    if ($settingsCount === 0) {
        $db->exec(
            "INSERT INTO settings (dark_theme, monthly_price, convert_currency, remove_background, color_theme, hide_disabled, user_id, disabled_to_bottom, show_original_price, mobile_nav)
             VALUES (2, 0, 0, 0, 'blue', 0, 1, 0, 0, 0)"
        );
    }

    if (wallos_column_exists($db, 'admin', 'login_disabled')) {
        $db->exec("UPDATE admin SET login_disabled = 1 WHERE id = 1");
    }

    if (empty($user['avatar'])) {
        $user['avatar'] = 'images/avatars/0.svg';
    }

    return $user;
}

?>
