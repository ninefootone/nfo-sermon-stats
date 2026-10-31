<?php
/**
 * Plugin Name:       Sermon Download Stats
 * Plugin URI:        https://github.com/ninefootone/nfo-sermon-stats
 * Description:       Shows sermon download statistics from sermons.download in the WordPress dashboard.
 * Version:           1.2.3
 * Author:            ninefootone creative
 * Author URI:        https://ninefootone.co.uk
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * License:           GPL-2.0-or-later
 * Text Domain:       nfo-sermon-stats
 */

defined( 'ABSPATH' ) || exit;

// Plugin Update Checker v5.5 (vendored — same copy as Church Events, do not upgrade without testing)
// https://github.com/YahnisElsts/plugin-update-checker
if ( file_exists( __DIR__ . '/lib/plugin-update-checker/plugin-update-checker.php' ) ) {
	require_once __DIR__ . '/lib/plugin-update-checker/plugin-update-checker.php';
	$nfo_ss_update_checker = \YahnisElsts\PluginUpdateChecker\v5\PucFactory::buildUpdateChecker(
		'https://github.com/ninefootone/nfo-sermon-stats',
		__FILE__,
		'nfo-sermon-stats'
	);
	$nfo_ss_update_checker->getVcsApi()->enableReleaseAssets();
	// Optional GitHub token (wp-config.php) to raise GitHub's update-check limit. Never put it in this repo.
	if ( defined( 'NFO_GITHUB_TOKEN' ) && NFO_GITHUB_TOKEN ) {
		$nfo_ss_update_checker->setAuthentication( NFO_GITHUB_TOKEN );
	}
}

final class NFO_Sermon_Stats {

	const VERSION          = '1.2.3';
	const OPTION           = 'nfo_sermon_stats_key';
	const DEFAULT_ENDPOINT = 'https://stats.sermons.download/v1/summary';
	const PAGE_SLUG        = 'nfo-sermon-stats';
	const CACHE_TTL        = HOUR_IN_SECONDS;
	const ERROR_TTL        = 5 * MINUTE_IN_SECONDS;

	public static function init() {
		add_action( 'wp_dashboard_setup', array( __CLASS__, 'register_widget' ) );
		add_action( 'admin_menu', array( __CLASS__, 'register_pages' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'admin_post_nfo_sermon_stats_refresh', array( __CLASS__, 'handle_refresh' ) );
		add_action( 'admin_head', array( __CLASS__, 'print_styles' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( __CLASS__, 'action_links' ) );
	}

	/* ---------- Config ---------- */

	/** Who can view stats. Default: anyone who can edit posts. */
	public static function capability() {
		return apply_filters( 'nfo_sermon_stats_capability', 'edit_posts' );
	}

	/** Key from wp-config (NFO_SERMON_STATS_KEY) wins over the settings field. */
	public static function get_key() {
		if ( defined( 'NFO_SERMON_STATS_KEY' ) ) {
			return strtolower( trim( (string) NFO_SERMON_STATS_KEY ) );
		}
		return strtolower( trim( (string) get_option( self::OPTION, '' ) ) );
	}

	public static function endpoint() {
		return defined( 'NFO_SERMON_STATS_ENDPOINT' ) ? NFO_SERMON_STATS_ENDPOINT : self::DEFAULT_ENDPOINT;
	}

	/** Cache name includes a hash of the key, so changing the key never shows stale data. */
	private static function cache_name( $key ) {
		return 'nfo_ss_' . substr( md5( $key ), 0, 12 );
	}

	/* ---------- Data ---------- */

	/**
	 * @return array|WP_Error Stats payload (with 'fetched_at' added) or an error.
	 */
	public static function get_stats( $force = false ) {
		$key = self::get_key();
		if ( '' === $key ) {
			return new WP_Error( 'no_key', __( 'No stats key has been set yet.', 'nfo-sermon-stats' ) );
		}

		$cache_name = self::cache_name( $key );
		if ( ! $force ) {
			$cached = get_transient( $cache_name );
			if ( is_array( $cached ) ) {
				return $cached['ok'] ? $cached['data'] : new WP_Error( $cached['code'], $cached['message'] );
			}
		}

		$response = wp_remote_get(
			self::endpoint(),
			array(
				'timeout'    => 8,
				'user-agent' => 'NFO-Sermon-Stats/' . self::VERSION . '; ' . home_url(),
				'headers'    => array(
					'Authorization' => 'Bearer ' . $key,
					'Accept'        => 'application/json',
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			$error = new WP_Error( 'http', __( 'Could not reach the stats service. Try again shortly.', 'nfo-sermon-stats' ) );
		} else {
			$code = (int) wp_remote_retrieve_response_code( $response );
			$data = json_decode( wp_remote_retrieve_body( $response ), true );

			if ( 401 === $code ) {
				$error = new WP_Error( 'bad_key', __( 'The stats key was not recognised. Check it in Settings → Sermon Stats.', 'nfo-sermon-stats' ) );
			} elseif ( 200 !== $code || ! is_array( $data ) || empty( $data['totals'] ) ) {
				/* translators: %d: HTTP status code */
				$error = new WP_Error( 'bad_response', sprintf( __( 'The stats service returned an error (%d). Try again shortly.', 'nfo-sermon-stats' ), $code ) );
			} else {
				$data['fetched_at'] = time();
				set_transient( $cache_name, array( 'ok' => true, 'data' => $data ), self::CACHE_TTL );
				return $data;
			}
		}

		// Cache failures briefly so a Cloudflare outage doesn't slow every admin page load.
		set_transient(
			$cache_name,
			array( 'ok' => false, 'code' => $error->get_error_code(), 'message' => $error->get_error_message() ),
			self::ERROR_TTL
		);
		return $error;
	}

	public static function handle_refresh() {
		if ( ! current_user_can( self::capability() ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to do that.', 'nfo-sermon-stats' ), 403 );
		}
		check_admin_referer( 'nfo_sermon_stats_refresh' );
		self::get_stats( true );
		wp_safe_redirect( wp_get_referer() ? wp_get_referer() : admin_url( 'index.php?page=' . self::PAGE_SLUG ) );
		exit;
	}

	/* ---------- Admin registration ---------- */

	public static function register_widget() {
		if ( current_user_can( self::capability() ) ) {
			wp_add_dashboard_widget( 'nfo_sermon_stats', __( 'Sermon Downloads', 'nfo-sermon-stats' ), array( __CLASS__, 'render_widget' ) );
		}
	}

	public static function register_pages() {
		add_dashboard_page(
			__( 'Sermon Stats', 'nfo-sermon-stats' ),
			__( 'Sermon Stats', 'nfo-sermon-stats' ),
			self::capability(),
			self::PAGE_SLUG,
			array( __CLASS__, 'render_page' )
		);
		add_options_page(
			__( 'Sermon Stats', 'nfo-sermon-stats' ),
			__( 'Sermon Stats', 'nfo-sermon-stats' ),
			'manage_options',
			self::PAGE_SLUG . '-settings',
			array( __CLASS__, 'render_settings' )
		);
	}

	public static function register_settings() {
		register_setting(
			'nfo_sermon_stats',
			self::OPTION,
			array(
				'type'              => 'string',
				'sanitize_callback' => array( __CLASS__, 'sanitize_key' ),
				'default'           => '',
				'autoload'          => false,
			)
		);
	}

	public static function sanitize_key( $value ) {
		$value = strtolower( preg_replace( '/[^a-fA-F0-9]/', '', (string) $value ) );
		if ( '' !== $value && 64 !== strlen( $value ) ) {
			add_settings_error( self::OPTION, 'bad_length', __( 'That doesn’t look like a valid stats key (it should be 64 characters).', 'nfo-sermon-stats' ) );
			return get_option( self::OPTION, '' );
		}
		return $value;
	}

	public static function action_links( $links ) {
		$url = admin_url( 'options-general.php?page=' . self::PAGE_SLUG . '-settings' );
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'nfo-sermon-stats' ) . '</a>' );
		return $links;
	}

	/* ---------- Rendering ---------- */

	public static function render_widget() {
		$stats = self::get_stats();
		if ( is_wp_error( $stats ) ) {
			self::render_error( $stats );
			return;
		}

		self::render_tiles( $stats['totals'] );

		echo '<h3 class="nfo-ss-heading">' . esc_html__( 'Most downloaded — last 30 days', 'nfo-sermon-stats' ) . '</h3>';
		self::render_file_list( array_slice( $stats['top_30_days'], 0, 5 ) );

		echo '<p class="nfo-ss-footer">';
		echo '<a href="' . esc_url( admin_url( 'index.php?page=' . self::PAGE_SLUG ) ) . '">' . esc_html__( 'View all sermon stats →', 'nfo-sermon-stats' ) . '</a>';
		echo '</p>';
		self::render_meta( $stats );
	}

	public static function render_page() {
		$stats = self::get_stats();
		echo '<div class="wrap nfo-ss">';
		echo '<h1>' . esc_html__( 'Sermon Download Stats', 'nfo-sermon-stats' ) . '</h1>';

		if ( is_wp_error( $stats ) ) {
			self::render_error( $stats );
			echo '</div>';
			return;
		}

		self::render_tiles( $stats['totals'] );

		echo '<div class="nfo-ss-grid">';

		echo '<div class="nfo-ss-card"><h2>' . esc_html__( 'Downloads by month', 'nfo-sermon-stats' ) . '</h2>';
		self::render_months( $stats['monthly'] );
		echo '</div>';

		echo '<div class="nfo-ss-card"><h2>' . esc_html__( 'Most downloaded — last 30 days', 'nfo-sermon-stats' ) . '</h2>';
		self::render_file_list( $stats['top_30_days'] );
		echo '</div>';

		echo '<div class="nfo-ss-card"><h2>' . esc_html__( 'Most downloaded — all time', 'nfo-sermon-stats' ) . '</h2>';
		self::render_file_list( $stats['top_all_time'] );
		echo '</div>';

		echo '<div class="nfo-ss-card"><h2>' . esc_html__( 'Where downloads come from', 'nfo-sermon-stats' ) . '</h2>';
		self::render_countries( $stats['countries'] );
		echo '</div>';

		echo '<div class="nfo-ss-card nfo-ss-wide"><h2>' . esc_html__( 'Latest downloads', 'nfo-sermon-stats' ) . '</h2>';
		self::render_recent( $stats['recent'] );
		echo '</div>';

		echo '</div>';

		self::render_meta( $stats, true );
		echo '</div>';
	}

	public static function render_settings() {
		echo '<div class="wrap"><h1>' . esc_html__( 'Sermon Stats', 'nfo-sermon-stats' ) . '</h1>';
		settings_errors( self::OPTION );
		echo '<form method="post" action="options.php">';
		settings_fields( 'nfo_sermon_stats' );
		echo '<table class="form-table" role="presentation"><tr><th scope="row"><label for="nfo-ss-key">' . esc_html__( 'Stats key', 'nfo-sermon-stats' ) . '</label></th><td>';

		if ( defined( 'NFO_SERMON_STATS_KEY' ) ) {
			echo '<p>' . esc_html__( 'The key is set in wp-config.php (NFO_SERMON_STATS_KEY).', 'nfo-sermon-stats' ) . '</p>';
		} else {
			$has_key = '' !== (string) get_option( self::OPTION, '' );
			printf(
				'<input type="password" id="nfo-ss-key" name="%1$s" value="%2$s" class="regular-text code" autocomplete="off" spellcheck="false" />',
				esc_attr( self::OPTION ),
				esc_attr( (string) get_option( self::OPTION, '' ) )
			);
			echo '<p class="description">' . ( $has_key
				? esc_html__( 'A key is saved. Paste a new one to replace it, or clear the field to remove it.', 'nfo-sermon-stats' )
				: esc_html__( 'Paste the key supplied by ninefootone creative.', 'nfo-sermon-stats' ) ) . '</p>';
		}

		echo '</td></tr></table>';
		if ( ! defined( 'NFO_SERMON_STATS_KEY' ) ) {
			submit_button();
		}
		echo '</form>';

		if ( '' !== self::get_key() ) {
			$stats = self::get_stats( true );
			if ( is_wp_error( $stats ) ) {
				self::render_error( $stats );
			} else {
				echo '<div class="notice notice-success inline"><p>' . esc_html__( 'Connected. Stats are working.', 'nfo-sermon-stats' ) . '</p></div>';
			}
		}
		echo '</div>';
	}

	private static function render_error( WP_Error $error ) {
		echo '<div class="notice notice-warning inline"><p>' . esc_html( $error->get_error_message() );
		if ( 'no_key' === $error->get_error_code() && current_user_can( 'manage_options' ) ) {
			echo ' <a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE_SLUG . '-settings' ) ) . '">' . esc_html__( 'Add a key', 'nfo-sermon-stats' ) . '</a>';
		}
		echo '</p></div>';
	}

	private static function render_tiles( array $t ) {
		$tiles = array(
			__( 'Last 7 days', 'nfo-sermon-stats' )  => $t['last_7'] ?? 0,
			__( 'Last 30 days', 'nfo-sermon-stats' ) => $t['last_30'] ?? 0,
			__( 'This month', 'nfo-sermon-stats' )   => $t['this_month'] ?? 0,
			__( 'All time', 'nfo-sermon-stats' )     => $t['all_time'] ?? 0,
		);
		echo '<div class="nfo-ss-tiles">';
		foreach ( $tiles as $label => $value ) {
			echo '<div class="nfo-ss-tile"><span class="nfo-ss-num">' . esc_html( number_format_i18n( (int) $value ) ) . '</span><span class="nfo-ss-label">' . esc_html( $label ) . '</span></div>';
		}
		echo '</div>';
	}

	private static function render_file_list( array $rows ) {
		if ( empty( $rows ) ) {
			echo '<p class="nfo-ss-empty">' . esc_html__( 'No downloads in this period yet.', 'nfo-sermon-stats' ) . '</p>';
			return;
		}
		echo '<ol class="nfo-ss-list">';
		foreach ( $rows as $row ) {
			$file = (string) ( $row['filename'] ?? '' );
			$path = (string) ( $row['path'] ?? $file );
			echo '<li><span class="nfo-ss-file" title="' . esc_attr( $path ) . '">' . self::sermon_label( $file, $path ) . '</span><span class="nfo-ss-count">' . esc_html( number_format_i18n( (int) ( $row['downloads'] ?? 0 ) ) ) . '</span></li>';
		}
		echo '</ol>';
	}

	/** Bar per month for the last 12 months, filling gaps with zero. */
	private static function render_months( array $rows ) {
		$counts = array();
		foreach ( $rows as $row ) {
			$counts[ (string) $row['month'] ] = (int) $row['downloads'];
		}
		$months = array();
		$start  = new DateTime( 'first day of this month', new DateTimeZone( 'UTC' ) );
		for ( $i = 11; $i >= 0; $i-- ) {
			$m            = ( clone $start )->modify( "-{$i} months" );
			$ym           = $m->format( 'Y-m' );
			$months[ $ym ] = $counts[ $ym ] ?? 0;
		}
		$max = max( 1, max( $months ) );

		echo '<div class="nfo-ss-bars">';
		foreach ( $months as $ym => $count ) {
			$label = date_i18n( 'M Y', strtotime( $ym . '-01 00:00:00 UTC' ) );
			$width = round( $count / $max * 100, 1 );
			echo '<div class="nfo-ss-bar-row"><span class="nfo-ss-bar-label">' . esc_html( $label ) . '</span><span class="nfo-ss-bar-track"><span class="nfo-ss-bar" style="width:' . esc_attr( $width ) . '%"></span></span><span class="nfo-ss-count">' . esc_html( number_format_i18n( $count ) ) . '</span></div>';
		}
		echo '</div>';
	}

	private static function render_countries( array $rows ) {
		if ( empty( $rows ) ) {
			echo '<p class="nfo-ss-empty">' . esc_html__( 'No country data yet.', 'nfo-sermon-stats' ) . '</p>';
			return;
		}
		echo '<ol class="nfo-ss-list">';
		foreach ( $rows as $row ) {
			echo '<li><span class="nfo-ss-file">' . esc_html( self::country_name( (string) $row['country'] ) ) . '</span><span class="nfo-ss-count">' . esc_html( number_format_i18n( (int) $row['downloads'] ) ) . '</span></li>';
		}
		echo '</ol>';
	}

	private static function render_recent( array $rows ) {
		if ( empty( $rows ) ) {
			echo '<p class="nfo-ss-empty">' . esc_html__( 'No downloads yet.', 'nfo-sermon-stats' ) . '</p>';
			return;
		}
		echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Sermon', 'nfo-sermon-stats' ) . '</th><th>' . esc_html__( 'Country', 'nfo-sermon-stats' ) . '</th><th>' . esc_html__( 'When', 'nfo-sermon-stats' ) . '</th></tr></thead><tbody>';
		foreach ( $rows as $row ) {
			$file = (string) $row['filename'];
			$path = (string) ( $row['path'] ?? $file );
			echo '<tr><td title="' . esc_attr( $path ) . '">' . self::sermon_label( $file, $path ) . '</td><td>' . esc_html( $row['country'] ? self::country_name( (string) $row['country'] ) : '—' ) . '</td><td>' . esc_html( self::format_time( (string) $row['downloaded_at'] ) ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function render_meta( array $stats, $full = false ) {
		$first = $stats['totals']['first_recorded'] ?? '';
		echo '<p class="nfo-ss-meta">';
		if ( $first ) {
			/* translators: %s: date */
			echo esc_html( sprintf( __( 'Counting since %s.', 'nfo-sermon-stats' ), self::format_time( $first, get_option( 'date_format' ) ) ) ) . ' ';
		}
		if ( ! empty( $stats['fetched_at'] ) ) {
			/* translators: %s: time ago, e.g. "5 mins" */
			echo esc_html( sprintf( __( 'Updated %s ago.', 'nfo-sermon-stats' ), human_time_diff( (int) $stats['fetched_at'] ) ) ) . ' ';
		}
		$refresh = wp_nonce_url( admin_url( 'admin-post.php?action=nfo_sermon_stats_refresh' ), 'nfo_sermon_stats_refresh' );
		echo '<a href="' . esc_url( $refresh ) . '">' . esc_html__( 'Refresh', 'nfo-sermon-stats' ) . '</a>';
		if ( $full ) {
			echo '<br>' . esc_html__( 'Each person is counted once per sermon per day, and known bots are left out. Figures before November 2026 are less precise. Country data is only available for recent downloads.', 'nfo-sermon-stats' );
		}
		echo '</p>';
	}

	/* ---------- Helpers ---------- */

	/** "2026-04-12_Morning-Service.mp3" → "2026-04-12 Morning Service". Full name stays in the tooltip. */
	/**
	 * Escaped HTML label: tidied filename, plus its folder (e.g. "2026/10") so files
	 * with the same name in different folders can be told apart.
	 */
	public static function sermon_label( $file, $path ) {
		$label  = esc_html( self::pretty_filename( $file ) );
		$folder = trim( (string) preg_replace( '#^.*?wp-content/uploads/#', '', dirname( $path ) ), '/.' );
		if ( '' !== $folder ) {
			$label .= ' <span class="nfo-ss-folder">' . esc_html( $folder ) . '</span>';
		}
		return $label;
	}

	public static function pretty_filename( $file ) {
		$name = preg_replace( '/\.[a-z0-9]{2,4}$/i', '', $file );
		$name = trim( preg_replace( '/[_\s]+|(?<!\d)-|-(?!\d)/', ' ', $name ) );
		return '' !== $name ? $name : $file;
	}

	public static function country_name( $code ) {
		$code = strtoupper( $code );
		if ( 'XX' === $code || 'T1' === $code ) {
			return __( 'Unknown', 'nfo-sermon-stats' );
		}
		if ( class_exists( 'Locale' ) ) {
			$name = Locale::getDisplayRegion( '-' . $code, get_locale() );
			if ( $name && $name !== $code ) {
				return $name;
			}
		}
		return $code;
	}

	/** Stats are stored in UTC; show them in the site's timezone. */
	private static function format_time( $value, $format = null ) {
		$ts = strtotime( $value . ( preg_match( '/(Z|[+-]\d\d:?\d\d)$/', $value ) ? '' : ' UTC' ) );
		if ( ! $ts ) {
			return $value;
		}
		$format = $format ? $format : get_option( 'date_format' ) . ' ' . get_option( 'time_format' );
		return wp_date( $format, $ts );
	}

	public static function print_styles() {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen || ! in_array( $screen->id, array( 'dashboard', 'dashboard_page_' . self::PAGE_SLUG ), true ) ) {
			return;
		}
		?>
		<style>
			.nfo-ss-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:4px 0 16px}
			.nfo-ss-tile{background:#f6f7f7;border-radius:4px;padding:10px 8px;text-align:center}
			.nfo-ss-num{display:block;font-size:22px;font-weight:600;line-height:1.2;color:#1d2327}
			.nfo-ss-label{display:block;font-size:12px;color:#646970}
			.nfo-ss-heading{font-size:13px;margin:0 0 6px}
			.nfo-ss-list{margin:0;padding:0;list-style:none}
			.nfo-ss-list li{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #f0f0f1;margin:0}
			.nfo-ss-file{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
			.nfo-ss-folder{color:#646970;font-size:12px;margin-left:4px}
			.nfo-ss-count{font-variant-numeric:tabular-nums;font-weight:600;flex-shrink:0}
			.nfo-ss-empty,.nfo-ss-meta{color:#646970}
			.nfo-ss-meta{font-size:12px;margin-top:12px}
			.nfo-ss-footer{margin:12px 0 0}
			.nfo-ss .nfo-ss-tiles{max-width:900px;margin-top:16px}
			.nfo-ss .nfo-ss-num{font-size:28px}
			.nfo-ss-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;max-width:1200px}
			.nfo-ss-card{background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:12px 16px 16px}
			.nfo-ss-card h2{font-size:14px;margin:0 0 10px}
			.nfo-ss-wide{grid-column:1/-1}
			.nfo-ss-bar-row{display:grid;grid-template-columns:70px 1fr 50px;align-items:center;gap:8px;padding:3px 0}
			.nfo-ss-bar-track{background:#f0f0f1;border-radius:2px;height:12px;overflow:hidden}
			.nfo-ss-bar{display:block;height:100%;background:#2271b1;border-radius:2px}
			.nfo-ss-bar-row .nfo-ss-count{text-align:right}
			@media (max-width:782px){.nfo-ss-tiles{grid-template-columns:repeat(2,1fr)}}
		</style>
		<?php
	}
}

NFO_Sermon_Stats::init();
