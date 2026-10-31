<?php
defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'nfo_sermon_stats_key' );

global $wpdb;
$wpdb->query(
	"DELETE FROM {$wpdb->options}
	 WHERE option_name LIKE '\_transient\_nfo\_ss\_%'
	    OR option_name LIKE '\_transient\_timeout\_nfo\_ss\_%'"
);
