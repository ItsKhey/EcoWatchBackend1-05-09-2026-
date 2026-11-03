--
-- PostgreSQL database dump
--

\restrict XzKjzeMGTAgRN1t5Axg8pvvqhdLIbteNRwa4PCM17vMMroMfLscrE4X10qqMMkt

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: enforce_account_identity_uniqueness(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_account_identity_uniqueness() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  normalized_username text;
  normalized_email text;
  current_identifier text;
  conflicting_account text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('myecowatch:account-identity-uniqueness:v1')
  );

  normalized_username := NULLIF(lower(btrim(NEW.username)), '');
  normalized_email := NULLIF(lower(btrim(NEW.email)), '');

  IF TG_TABLE_NAME = 'personnel_accounts' THEN
    current_identifier := NEW.personnel_id::text;
  ELSIF TG_TABLE_NAME = 'residents' THEN
    current_identifier := NEW.resident_id::text;
  ELSE
    current_identifier := NEW.admin_id::text;
  END IF;

  SELECT source
  INTO conflicting_account
  FROM (
    SELECT 'admins' AS source
    FROM public.admins
    WHERE lower(username) = normalized_username
      AND admin_id::text <> current_identifier

    UNION ALL

    SELECT 'residents' AS source
    FROM public.residents
    WHERE lower(username) = normalized_username
      AND resident_id::text <> current_identifier

    UNION ALL

    SELECT 'personnel_accounts' AS source
    FROM public.personnel_accounts
    WHERE lower(username) = normalized_username
      AND personnel_id::text <> current_identifier

    UNION ALL

    SELECT 'admins' AS source
    FROM public.admins
    WHERE email IS NOT NULL
      AND lower(email) = normalized_email
      AND admin_id::text <> current_identifier

    UNION ALL

    SELECT 'residents' AS source
    FROM public.residents
    WHERE email IS NOT NULL
      AND lower(email) = normalized_email
      AND resident_id::text <> current_identifier

    UNION ALL

    SELECT 'personnel_accounts' AS source
    FROM public.personnel_accounts
    WHERE lower(email) = normalized_email
      AND personnel_id::text <> current_identifier
  ) conflicts
  LIMIT 1;

  IF conflicting_account IS NOT NULL THEN
    RAISE EXCEPTION 'Username or email is already registered'
      USING
        ERRCODE = '23505',
        CONSTRAINT = 'account_identity_unique',
        SCHEMA = 'public',
        TABLE = TG_TABLE_NAME;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: next_personnel_account_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_personnel_account_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT 'PERS-' || LPAD(nextval('public.personnel_account_id_seq')::text, 4, '0');
$$;


--
-- Name: set_personnel_account_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_personnel_account_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.current_assignment_report_id IS NULL THEN
    NEW.is_cleaning = false;
    NEW.current_assignment = NULL;
    NEW.current_assignment_location = NULL;
    NEW.current_assignment_assigned_at = NULL;

    IF NEW.status = 'CLEANING' THEN
      NEW.status = 'OFFLINE';
    END IF;
  ELSE
    NEW.is_cleaning = true;
    IF NEW.status <> 'CLEANING' THEN
      NEW.status = 'CLEANING';
    END IF;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    NEW.enabled = false;
    -- A soft-deleted account may retain an auditable historical assignment;
    -- keep the cleaning relationship internally consistent until the report
    -- FK is cleared. Normal assignment paths reject such accounts up front.
    IF NEW.current_assignment_report_id IS NULL THEN
      NEW.is_cleaning = false;
      NEW.status = 'OFFLINE';
    END IF;
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notification_preferences (
    admin_id character varying(255) NOT NULL,
    master_enabled boolean DEFAULT true NOT NULL,
    report_status_updates boolean DEFAULT true NOT NULL,
    report_completed boolean DEFAULT true NOT NULL,
    report_denied boolean DEFAULT true NOT NULL,
    cenro_announcements boolean DEFAULT true NOT NULL,
    security_alerts boolean DEFAULT true NOT NULL,
    high_priority_reports boolean DEFAULT true NOT NULL,
    personnel_accepted boolean DEFAULT true NOT NULL,
    personnel_cleaning boolean DEFAULT true NOT NULL,
    photo_updates boolean DEFAULT true NOT NULL,
    awaiting_approval boolean DEFAULT true NOT NULL,
    archived_reports boolean DEFAULT true NOT NULL,
    maintenance_alerts boolean DEFAULT true NOT NULL,
    sound_enabled boolean DEFAULT true NOT NULL,
    vibration_enabled boolean DEFAULT true NOT NULL,
    sound_uri text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE admin_notification_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admin_notification_preferences IS 'Per-administrator notification choices. Absence of a row means every category is enabled.';


--
-- Name: admin_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notifications (
    notification_id bigint NOT NULL,
    resident_id character varying(100) NOT NULL,
    report_id character varying(100),
    title text NOT NULL,
    message text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type character varying(64) DEFAULT 'NEW_REPORT'::character varying NOT NULL
);


--
-- Name: admin_notifications_notification_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_notifications_notification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notifications_notification_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_notifications_notification_id_seq OWNED BY public.admin_notifications.notification_id;


--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    id bigint NOT NULL,
    admin_id character varying(30) NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    username character varying(50) NOT NULL,
    email character varying(255),
    password_hash text NOT NULL,
    address text,
    profile_image text,
    is_verified boolean DEFAULT false,
    role character varying(50),
    phone_number character varying(50),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    last_active timestamp with time zone,
    fcm_token text,
    firebase_uid text,
    email_verified boolean DEFAULT false NOT NULL,
    verification_sent_at timestamp with time zone,
    verified_at timestamp with time zone
);


--
-- Name: COLUMN admins.firebase_uid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admins.firebase_uid IS 'Firebase Auth identity that proves this email address. NULL for accounts predating Firebase verification.';


--
-- Name: COLUMN admins.email_verified; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admins.email_verified IS 'True when this email address was proven (Firebase email-link, or the legacy OTP code). Audit only; never a login condition.';


--
-- Name: COLUMN admins.verification_sent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admins.verification_sent_at IS 'When a verification link was last issued to this address. Also the resend cooldown clock.';


--
-- Name: COLUMN admins.verified_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admins.verified_at IS 'When this email address was first proven.';


--
-- Name: admins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admins_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admins_id_seq OWNED BY public.admins.id;


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id bigint NOT NULL,
    created_by_admin_id character varying(255),
    title character varying(150) NOT NULL,
    message text NOT NULL,
    audience character varying(32) DEFAULT 'ALL_RESIDENTS'::character varying NOT NULL,
    barangay character varying(150),
    target_resident_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
    priority character varying(16) DEFAULT 'NORMAL'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    expires_at timestamp with time zone,
    CONSTRAINT announcements_audience_check CHECK (((audience)::text = ANY ((ARRAY['ALL_RESIDENTS'::character varying, 'BARANGAY'::character varying, 'SELECTED_RESIDENTS'::character varying])::text[]))),
    CONSTRAINT announcements_priority_check CHECK (((priority)::text = ANY ((ARRAY['NORMAL'::character varying, 'IMPORTANT'::character varying])::text[])))
);


--
-- Name: announcements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.announcements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: announcements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.announcements_id_seq OWNED BY public.announcements.id;


--
-- Name: archived_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.archived_reports (
    id bigint NOT NULL,
    report_id character varying(50) NOT NULL,
    resident_id character varying(30),
    title text,
    category character varying(100),
    description text,
    latitude double precision,
    longitude double precision,
    image_url text,
    status character varying(50),
    admin_response text,
    assigned_personnel_ids text[],
    priority character varying(30),
    deleted_at timestamp with time zone,
    restored_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    assigned_personnel_id character varying(9),
    assigned_by_admin_id character varying(50),
    assigned_at timestamp with time zone,
    cluster_id text
);


--
-- Name: archived_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.archived_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: archived_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.archived_reports_id_seq OWNED BY public.archived_reports.id;


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    resident_id character varying(255) NOT NULL,
    master_enabled boolean DEFAULT true NOT NULL,
    report_status_updates boolean DEFAULT true NOT NULL,
    report_completed boolean DEFAULT true NOT NULL,
    report_denied boolean DEFAULT true NOT NULL,
    cenro_announcements boolean DEFAULT true NOT NULL,
    security_alerts boolean DEFAULT true NOT NULL,
    sound_enabled boolean DEFAULT true NOT NULL,
    vibration_enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sound_uri text
);


--
-- Name: TABLE notification_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_preferences IS 'Per-resident notification choices. Absence of a row means every category is enabled.';


--
-- Name: COLUMN notification_preferences.master_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.master_enabled IS 'When false no push is sent at all. Defaults true so an absent row fails open.';


--
-- Name: COLUMN notification_preferences.cenro_announcements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.cenro_announcements IS 'Whether to push CENRO announcements. Muting suppresses the push only; the announcement still appears in the feed and the Alerts list.';


--
-- Name: COLUMN notification_preferences.sound_uri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.sound_uri IS 'Custom notification ringtone chosen by the resident. NULL uses the device default.';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    notification_id bigint DEFAULT nextval((pg_get_serial_sequence('public.notifications'::text, 'notification_id'::text))::regclass) NOT NULL,
    resident_id character varying(30) NOT NULL,
    report_id character varying(50),
    title text NOT NULL,
    message text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type character varying(64) DEFAULT 'REPORT_UPDATE'::character varying NOT NULL,
    id bigint GENERATED ALWAYS AS (notification_id) STORED,
    CONSTRAINT notifications_type_ck CHECK (((type)::text = ANY ((ARRAY['PERSONNEL_ASSIGNED'::character varying, 'PERSONNEL_UNASSIGNED'::character varying, 'CLEANING_STARTED'::character varying, 'ADMIN_RESPONSE_UPDATED'::character varying, 'REPORT_DENIED'::character varying, 'REPORT_COMPLETED'::character varying, 'REPORT_UPDATE'::character varying, 'NEW_REPORT'::character varying, 'ANNOUNCEMENT'::character varying])::text[])))
);


--
-- Name: TABLE notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notifications IS 'Server-created resident report notifications. Clients may list and mark their own rows read but cannot create notification content.';


--
-- Name: COLUMN notifications.report_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.report_id IS 'Owning report. NULL for broadcasts such as ANNOUNCEMENT, which are not tied to a report.';


--
-- Name: COLUMN notifications.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.type IS 'Server-owned report event classification used by in-app and FCM delivery.';


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.notification_id;


--
-- Name: password_reset_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_otps (
    id bigint NOT NULL,
    user_id character varying(30),
    otp_hash text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone,
    email character varying(255),
    attempts integer DEFAULT 0 NOT NULL
);


--
-- Name: COLUMN password_reset_otps.otp_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.password_reset_otps.otp_hash IS 'Legacy 4-digit OTP hash. NULL when this row is only a rate-limit marker for a Firebase reset link.';


--
-- Name: password_reset_otps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.password_reset_otps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_otps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.password_reset_otps_id_seq OWNED BY public.password_reset_otps.id;


--
-- Name: pending_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_registrations (
    id bigint NOT NULL,
    username character varying(50),
    email character varying(255),
    first_name character varying(100),
    last_name character varying(100),
    password_hash text,
    otp_hash text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone,
    registration_id character varying(100),
    attempts integer DEFAULT 0 NOT NULL,
    firebase_uid text,
    verification_flow text DEFAULT 'OTP'::text NOT NULL,
    verification_sent_at timestamp with time zone
);


--
-- Name: COLUMN pending_registrations.firebase_uid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pending_registrations.firebase_uid IS 'Unverified Firebase identity for this signup. NULL for legacy OTP registrations.';


--
-- Name: COLUMN pending_registrations.verification_flow; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pending_registrations.verification_flow IS 'OTP = legacy 4-digit code, EMAIL_LINK = Firebase verification link. Selects which verification branch applies.';


--
-- Name: COLUMN pending_registrations.verification_sent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pending_registrations.verification_sent_at IS 'When a verification link was last issued. Also the resend cooldown clock.';


--
-- Name: pending_registrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pending_registrations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pending_registrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pending_registrations_id_seq OWNED BY public.pending_registrations.id;


--
-- Name: personnel_account_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.personnel_account_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 9999
    CACHE 1;


--
-- Name: personnel_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personnel_accounts (
    personnel_id character varying(9) DEFAULT public.next_personnel_account_id() NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    address text DEFAULT ''::text NOT NULL,
    email character varying(255) NOT NULL,
    username character varying(50) NOT NULL,
    password_hash text NOT NULL,
    role character varying(30) DEFAULT 'PERSONNEL'::character varying NOT NULL,
    status character varying(20) DEFAULT 'OFFLINE'::character varying NOT NULL,
    last_active timestamp with time zone,
    current_assignment_report_id character varying(50),
    current_assignment_location jsonb,
    current_assignment_assigned_at timestamp with time zone,
    enabled boolean DEFAULT true NOT NULL,
    disabled_at timestamp with time zone,
    deleted_at timestamp with time zone,
    phone_number character varying(25),
    created_by_admin_id character varying(50),
    updated_by_admin_id character varying(50),
    disabled_by_admin_id character varying(50),
    deleted_by_admin_id character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_cleaning boolean DEFAULT false NOT NULL,
    current_assignment text,
    profile_image text,
    CONSTRAINT personnel_accounts_address_ck CHECK (((address = btrim(address)) AND (char_length(address) <= 300))),
    CONSTRAINT personnel_accounts_cleaning_assignment_ck CHECK ((((status)::text <> 'CLEANING'::text) OR (current_assignment_report_id IS NOT NULL))),
    CONSTRAINT personnel_accounts_deleted_state_ck CHECK (((deleted_at IS NULL) OR (enabled = false))),
    CONSTRAINT personnel_accounts_disabled_state_ck CHECK ((((enabled = true) AND (disabled_at IS NULL)) OR ((enabled = false) AND (disabled_at IS NOT NULL)))),
    CONSTRAINT personnel_accounts_first_name_ck CHECK ((((first_name)::text = btrim((first_name)::text)) AND ((char_length((first_name)::text) >= 1) AND (char_length((first_name)::text) <= 100)))),
    CONSTRAINT personnel_accounts_gmail_ck CHECK ((((email)::text = lower((email)::text)) AND ((email)::text ~ '^[a-z0-9._%+-]+@gmail\.com$'::text))),
    CONSTRAINT personnel_accounts_id_format_ck CHECK (((personnel_id)::text ~ '^PERS-[0-9]{4}$'::text)),
    CONSTRAINT personnel_accounts_last_name_ck CHECK ((((last_name)::text = btrim((last_name)::text)) AND ((char_length((last_name)::text) >= 1) AND (char_length((last_name)::text) <= 100)))),
    CONSTRAINT personnel_accounts_location_ck CHECK (((current_assignment_location IS NULL) OR (jsonb_typeof(current_assignment_location) = 'object'::text))),
    CONSTRAINT personnel_accounts_phase2b_assignment_ck CHECK ((((is_cleaning = false) AND (current_assignment_report_id IS NULL)) OR ((is_cleaning = true) AND (current_assignment_report_id IS NOT NULL) AND ((status)::text = 'CLEANING'::text)))),
    CONSTRAINT personnel_accounts_phone_ck CHECK (((phone_number IS NULL) OR ((phone_number)::text ~ '^[0-9+() .-]{7,25}$'::text))),
    CONSTRAINT personnel_accounts_role_ck CHECK (((role)::text = 'PERSONNEL'::text)),
    CONSTRAINT personnel_accounts_status_ck CHECK (((status)::text = ANY ((ARRAY['ONLINE'::character varying, 'OFFLINE'::character varying, 'CLEANING'::character varying])::text[]))),
    CONSTRAINT personnel_accounts_username_ck CHECK (((username)::text ~ '^[a-z0-9][a-z0-9._-]{2,49}$'::text))
);


--
-- Name: TABLE personnel_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.personnel_accounts IS 'Admin-managed environmental services personnel accounts. Personnel cannot self-register.';


--
-- Name: COLUMN personnel_accounts.current_assignment_report_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.personnel_accounts.current_assignment_report_id IS 'The report currently being handled by this personnel account.';


--
-- Name: COLUMN personnel_accounts.current_assignment_location; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.personnel_accounts.current_assignment_location IS 'Location snapshot captured from the current report assignment.';


--
-- Name: COLUMN personnel_accounts.is_cleaning; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.personnel_accounts.is_cleaning IS 'Server-owned cleaning flag synchronized with the current report assignment.';


--
-- Name: COLUMN personnel_accounts.current_assignment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.personnel_accounts.current_assignment IS 'Human-readable title of the current report assignment.';


--
-- Name: COLUMN personnel_accounts.profile_image; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.personnel_accounts.profile_image IS 'Optional server-managed personnel avatar URL.';


--
-- Name: report_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_clusters (
    cluster_id text NOT NULL,
    center_latitude numeric(10,8) NOT NULL,
    center_longitude numeric(11,8) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'Pending'::text NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: report_clusters_idempotency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_clusters_idempotency (
    latitude_bucket numeric(10,8) NOT NULL,
    longitude_bucket numeric(11,8) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: report_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_histories (
    id bigint NOT NULL,
    resident_id character varying(30),
    report_id character varying(50),
    action character varying(100),
    old_status character varying(50),
    new_status character varying(50),
    description text,
    is_deleted boolean DEFAULT false,
    deleted_at timestamp with time zone,
    "timestamp" timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: report_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.report_histories_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: report_histories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.report_histories_id_seq OWNED BY public.report_histories.id;


--
-- Name: report_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_photos (
    photo_id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id text NOT NULL,
    image_url text NOT NULL,
    order_index integer DEFAULT 0 NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id bigint NOT NULL,
    report_id character varying(50) NOT NULL,
    resident_id character varying(30) NOT NULL,
    title text,
    category character varying(100),
    description text,
    latitude double precision,
    longitude double precision,
    image_url text,
    status character varying(50) DEFAULT 'Pending'::character varying NOT NULL,
    admin_response text,
    assigned_personnel_ids text[],
    priority character varying(30),
    is_deleted boolean DEFAULT false,
    deleted_at timestamp with time zone,
    is_archived boolean DEFAULT false,
    is_restored boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    handled_by_id character varying,
    resolution_image_url text,
    resolved_at timestamp with time zone,
    assigned_personnel_id character varying(9),
    assigned_by_admin_id character varying(50),
    assigned_at timestamp with time zone,
    cluster_id text,
    CONSTRAINT reports_assigned_personnel_format_ck CHECK (((assigned_personnel_id IS NULL) OR ((assigned_personnel_id)::text ~ '^PERS-[0-9]{4}$'::text))),
    CONSTRAINT reports_assignment_timestamp_ck CHECK (((assigned_personnel_id IS NULL) OR (assigned_at IS NOT NULL)))
);


--
-- Name: COLUMN reports.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reports.created_at IS 'Authoritative server-owned report submission timestamp used by every client.';


--
-- Name: COLUMN reports.assigned_personnel_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reports.assigned_personnel_id IS 'Canonical active personnel account assigned to this report.';


--
-- Name: COLUMN reports.assigned_by_admin_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reports.assigned_by_admin_id IS 'Authenticated administrator who performed the assignment or reassignment.';


--
-- Name: COLUMN reports.assigned_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reports.assigned_at IS 'Server-owned timestamp for the current assignment.';


--
-- Name: reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reports_id_seq OWNED BY public.reports.id;


--
-- Name: residents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.residents (
    id bigint NOT NULL,
    resident_id character varying(30) NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    username character varying(50) NOT NULL,
    email character varying(255),
    password_hash text NOT NULL,
    profile_image text,
    address text,
    is_verified boolean DEFAULT false,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    role character varying(50) DEFAULT 'RESIDENT'::character varying NOT NULL,
    status character varying(50) DEFAULT 'AVAILABLE'::character varying NOT NULL,
    phone_number character varying(50),
    created_by_id character varying(100),
    last_active timestamp with time zone,
    fcm_token text,
    disabled_by_resident boolean DEFAULT false NOT NULL,
    disabled_at timestamp with time zone,
    firebase_uid text,
    email_verified boolean DEFAULT false NOT NULL,
    verification_sent_at timestamp with time zone,
    verified_at timestamp with time zone
);


--
-- Name: COLUMN residents.fcm_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.residents.fcm_token IS 'Current FCM registration token for this resident device; never exposed by profile APIs.';


--
-- Name: COLUMN residents.disabled_by_resident; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.residents.disabled_by_resident IS 'True when the resident paused their own account; only this state is auto-restored on the next successful login.';


--
-- Name: COLUMN residents.disabled_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.residents.disabled_at IS 'Server-owned timestamp of the most recent self-service account pause.';


--
-- Name: COLUMN residents.firebase_uid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.residents.firebase_uid IS 'Firebase Auth identity that proves this email address. NULL for accounts predating Firebase verification.';


--
-- Name: COLUMN residents.email_verified; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.residents.email_verified IS 'True when this email address was proven (Firebase email-link, or the legacy OTP code). Audit only; never a login condition.';


--
-- Name: COLUMN residents.verification_sent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.residents.verification_sent_at IS 'When a verification link was last issued to this address. Also the resend cooldown clock.';


--
-- Name: COLUMN residents.verified_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.residents.verified_at IS 'When this email address was first proven.';


--
-- Name: residents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.residents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: residents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.residents_id_seq OWNED BY public.residents.id;


--
-- Name: trash_admin_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trash_admin_notifications (
    notification_id bigint NOT NULL,
    resident_id character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trash_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trash_histories (
    id bigint NOT NULL,
    history_id bigint,
    resident_id character varying(30),
    report_id character varying(50),
    deleted_at timestamp with time zone,
    created_at timestamp with time zone
);


--
-- Name: trash_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trash_histories_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trash_histories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trash_histories_id_seq OWNED BY public.trash_histories.id;


--
-- Name: trash_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trash_notifications (
    id bigint NOT NULL,
    notification_id bigint NOT NULL,
    resident_id character varying(30),
    deleted_at timestamp with time zone,
    created_at timestamp with time zone
);


--
-- Name: trash_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trash_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trash_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trash_notifications_id_seq OWNED BY public.trash_notifications.id;


--
-- Name: trash_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trash_reports (
    id bigint NOT NULL,
    report_id character varying(50) NOT NULL,
    resident_id character varying(30),
    deleted_at timestamp with time zone,
    created_at timestamp with time zone
);


--
-- Name: trash_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trash_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trash_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trash_reports_id_seq OWNED BY public.trash_reports.id;


--
-- Name: admin_notifications notification_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications ALTER COLUMN notification_id SET DEFAULT nextval('public.admin_notifications_notification_id_seq'::regclass);


--
-- Name: admins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins ALTER COLUMN id SET DEFAULT nextval('public.admins_id_seq'::regclass);


--
-- Name: announcements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements ALTER COLUMN id SET DEFAULT nextval('public.announcements_id_seq'::regclass);


--
-- Name: archived_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archived_reports ALTER COLUMN id SET DEFAULT nextval('public.archived_reports_id_seq'::regclass);


--
-- Name: password_reset_otps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_otps ALTER COLUMN id SET DEFAULT nextval('public.password_reset_otps_id_seq'::regclass);


--
-- Name: pending_registrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_registrations ALTER COLUMN id SET DEFAULT nextval('public.pending_registrations_id_seq'::regclass);


--
-- Name: report_histories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_histories ALTER COLUMN id SET DEFAULT nextval('public.report_histories_id_seq'::regclass);


--
-- Name: reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports ALTER COLUMN id SET DEFAULT nextval('public.reports_id_seq'::regclass);


--
-- Name: residents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.residents ALTER COLUMN id SET DEFAULT nextval('public.residents_id_seq'::regclass);


--
-- Name: trash_histories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_histories ALTER COLUMN id SET DEFAULT nextval('public.trash_histories_id_seq'::regclass);


--
-- Name: trash_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_notifications ALTER COLUMN id SET DEFAULT nextval('public.trash_notifications_id_seq'::regclass);


--
-- Name: trash_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_reports ALTER COLUMN id SET DEFAULT nextval('public.trash_reports_id_seq'::regclass);


--
-- Name: admin_notification_preferences admin_notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_pkey PRIMARY KEY (admin_id);


--
-- Name: admin_notifications admin_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_pkey PRIMARY KEY (notification_id);


--
-- Name: admins admins_admin_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_admin_id_key UNIQUE (admin_id);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);


--
-- Name: admins admins_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_username_key UNIQUE (username);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: archived_reports archived_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archived_reports
    ADD CONSTRAINT archived_reports_pkey PRIMARY KEY (id);


--
-- Name: archived_reports archived_reports_report_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archived_reports
    ADD CONSTRAINT archived_reports_report_id_key UNIQUE (report_id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (resident_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (notification_id);


--
-- Name: password_reset_otps password_reset_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_otps
    ADD CONSTRAINT password_reset_otps_pkey PRIMARY KEY (id);


--
-- Name: pending_registrations pending_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_registrations
    ADD CONSTRAINT pending_registrations_pkey PRIMARY KEY (id);


--
-- Name: personnel_accounts personnel_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accounts
    ADD CONSTRAINT personnel_accounts_pkey PRIMARY KEY (personnel_id);


--
-- Name: report_clusters_idempotency report_clusters_idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_clusters_idempotency
    ADD CONSTRAINT report_clusters_idempotency_pkey PRIMARY KEY (latitude_bucket, longitude_bucket);


--
-- Name: report_clusters report_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_clusters
    ADD CONSTRAINT report_clusters_pkey PRIMARY KEY (cluster_id);


--
-- Name: report_histories report_histories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_histories
    ADD CONSTRAINT report_histories_pkey PRIMARY KEY (id);


--
-- Name: report_photos report_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_photos
    ADD CONSTRAINT report_photos_pkey PRIMARY KEY (photo_id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: reports reports_report_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_report_id_key UNIQUE (report_id);


--
-- Name: residents residents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.residents
    ADD CONSTRAINT residents_pkey PRIMARY KEY (id);


--
-- Name: residents residents_resident_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.residents
    ADD CONSTRAINT residents_resident_id_key UNIQUE (resident_id);


--
-- Name: residents residents_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.residents
    ADD CONSTRAINT residents_username_key UNIQUE (username);


--
-- Name: trash_admin_notifications trash_admin_notifications_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_admin_notifications
    ADD CONSTRAINT trash_admin_notifications_pk PRIMARY KEY (resident_id, notification_id);


--
-- Name: trash_histories trash_histories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_histories
    ADD CONSTRAINT trash_histories_pkey PRIMARY KEY (id);


--
-- Name: trash_notifications trash_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_notifications
    ADD CONSTRAINT trash_notifications_pkey PRIMARY KEY (id);


--
-- Name: trash_reports trash_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_reports
    ADD CONSTRAINT trash_reports_pkey PRIMARY KEY (id);


--
-- Name: trash_reports trash_reports_report_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_reports
    ADD CONSTRAINT trash_reports_report_id_key UNIQUE (report_id);


--
-- Name: admins_firebase_uid_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admins_firebase_uid_key ON public.admins USING btree (firebase_uid) WHERE (firebase_uid IS NOT NULL);


--
-- Name: archived_reports_assigned_personnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX archived_reports_assigned_personnel_idx ON public.archived_reports USING btree (assigned_personnel_id) WHERE (assigned_personnel_id IS NOT NULL);


--
-- Name: idx_admins_last_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admins_last_active ON public.admins USING btree (last_active DESC);


--
-- Name: idx_announcements_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcements_created_at ON public.announcements USING btree (created_at DESC, id DESC);


--
-- Name: idx_announcements_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcements_expires_at ON public.announcements USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_archived_reports_resident_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_archived_reports_resident_created_at ON public.archived_reports USING btree (resident_id, created_at DESC);


--
-- Name: idx_report_clusters_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_clusters_status ON public.report_clusters USING btree (status);


--
-- Name: idx_report_photos_report_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_photos_report_id ON public.report_photos USING btree (report_id);


--
-- Name: idx_report_photos_report_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_photos_report_order ON public.report_photos USING btree (report_id, order_index);


--
-- Name: idx_reports_cluster_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_cluster_id ON public.reports USING btree (cluster_id);


--
-- Name: idx_reports_resident_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_resident_created_at ON public.reports USING btree (resident_id, created_at DESC);


--
-- Name: idx_residents_last_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_residents_last_active ON public.residents USING btree (last_active DESC);


--
-- Name: index_admin_notifications_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_admin_notifications_owner ON public.admin_notifications USING btree (resident_id, notification_id);


--
-- Name: index_admin_notifications_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_admin_notifications_report ON public.admin_notifications USING btree (resident_id, report_id);


--
-- Name: index_admin_notifications_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_admin_notifications_unread ON public.admin_notifications USING btree (resident_id, is_read);


--
-- Name: index_admins_fcm_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_admins_fcm_token ON public.admins USING btree (fcm_token);


--
-- Name: notifications_report_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_report_idx ON public.notifications USING btree (report_id) WHERE (report_id IS NOT NULL);


--
-- Name: notifications_resident_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_resident_created_idx ON public.notifications USING btree (resident_id, created_at DESC);


--
-- Name: notifications_resident_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_resident_unread_idx ON public.notifications USING btree (resident_id, created_at DESC) WHERE (is_read = false);


--
-- Name: pending_registrations_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_registrations_email_idx ON public.pending_registrations USING btree (lower((email)::text));


--
-- Name: pending_registrations_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_registrations_expires_at_idx ON public.pending_registrations USING btree (expires_at);


--
-- Name: pending_registrations_registration_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pending_registrations_registration_id_key ON public.pending_registrations USING btree (registration_id);


--
-- Name: personnel_accounts_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personnel_accounts_active_idx ON public.personnel_accounts USING btree (created_at DESC) WHERE ((enabled = true) AND (deleted_at IS NULL));


--
-- Name: personnel_accounts_assignment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personnel_accounts_assignment_idx ON public.personnel_accounts USING btree (current_assignment_report_id) WHERE (current_assignment_report_id IS NOT NULL);


--
-- Name: personnel_accounts_email_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personnel_accounts_email_lower_uidx ON public.personnel_accounts USING btree (lower((email)::text));


--
-- Name: personnel_accounts_phase2b_busy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personnel_accounts_phase2b_busy_idx ON public.personnel_accounts USING btree (current_assignment_report_id, is_cleaning) WHERE (current_assignment_report_id IS NOT NULL);


--
-- Name: personnel_accounts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personnel_accounts_status_idx ON public.personnel_accounts USING btree (status, last_active DESC) WHERE (deleted_at IS NULL);


--
-- Name: personnel_accounts_username_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personnel_accounts_username_lower_uidx ON public.personnel_accounts USING btree (lower((username)::text));


--
-- Name: reports_active_assigned_personnel_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX reports_active_assigned_personnel_uidx ON public.reports USING btree (assigned_personnel_id) WHERE ((assigned_personnel_id IS NOT NULL) AND (is_deleted = false) AND (is_archived = false));


--
-- Name: reports_assigned_by_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_assigned_by_admin_idx ON public.reports USING btree (assigned_by_admin_id) WHERE (assigned_by_admin_id IS NOT NULL);


--
-- Name: reports_assigned_personnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_assigned_personnel_idx ON public.reports USING btree (assigned_personnel_id) WHERE (assigned_personnel_id IS NOT NULL);


--
-- Name: residents_fcm_token_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX residents_fcm_token_uidx ON public.residents USING btree (fcm_token) WHERE (fcm_token IS NOT NULL);


--
-- Name: residents_firebase_uid_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX residents_firebase_uid_key ON public.residents USING btree (firebase_uid) WHERE (firebase_uid IS NOT NULL);


--
-- Name: trash_notifications_resident_notification_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX trash_notifications_resident_notification_uidx ON public.trash_notifications USING btree (resident_id, notification_id);


--
-- Name: admins account_identity_uniqueness_admins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_identity_uniqueness_admins BEFORE INSERT OR UPDATE OF username, email ON public.admins FOR EACH ROW EXECUTE FUNCTION public.enforce_account_identity_uniqueness();


--
-- Name: personnel_accounts account_identity_uniqueness_personnel; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_identity_uniqueness_personnel BEFORE INSERT OR UPDATE OF username, email ON public.personnel_accounts FOR EACH ROW EXECUTE FUNCTION public.enforce_account_identity_uniqueness();


--
-- Name: residents account_identity_uniqueness_residents; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_identity_uniqueness_residents BEFORE INSERT OR UPDATE OF username, email ON public.residents FOR EACH ROW EXECUTE FUNCTION public.enforce_account_identity_uniqueness();


--
-- Name: personnel_accounts personnel_accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER personnel_accounts_set_updated_at BEFORE UPDATE ON public.personnel_accounts FOR EACH ROW EXECUTE FUNCTION public.set_personnel_account_updated_at();


--
-- Name: admin_notification_preferences admin_notification_preferences_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(admin_id) ON DELETE CASCADE;


--
-- Name: admin_notifications admin_notifications_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_admin_fk FOREIGN KEY (resident_id) REFERENCES public.admins(admin_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: reports fk_reports_resident; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT fk_reports_resident FOREIGN KEY (resident_id) REFERENCES public.residents(resident_id);


--
-- Name: notification_preferences notification_preferences_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES public.residents(resident_id) ON DELETE CASCADE;


--
-- Name: notifications notifications_report_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_report_fk FOREIGN KEY (report_id) REFERENCES public.reports(report_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: notifications notifications_resident_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_resident_fk FOREIGN KEY (resident_id) REFERENCES public.residents(resident_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: personnel_accounts personnel_accounts_created_by_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accounts
    ADD CONSTRAINT personnel_accounts_created_by_admin_fk FOREIGN KEY (created_by_admin_id) REFERENCES public.admins(admin_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: personnel_accounts personnel_accounts_current_assignment_report_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accounts
    ADD CONSTRAINT personnel_accounts_current_assignment_report_fk FOREIGN KEY (current_assignment_report_id) REFERENCES public.reports(report_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: personnel_accounts personnel_accounts_deleted_by_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accounts
    ADD CONSTRAINT personnel_accounts_deleted_by_admin_fk FOREIGN KEY (deleted_by_admin_id) REFERENCES public.admins(admin_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: personnel_accounts personnel_accounts_disabled_by_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accounts
    ADD CONSTRAINT personnel_accounts_disabled_by_admin_fk FOREIGN KEY (disabled_by_admin_id) REFERENCES public.admins(admin_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: personnel_accounts personnel_accounts_updated_by_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personnel_accounts
    ADD CONSTRAINT personnel_accounts_updated_by_admin_fk FOREIGN KEY (updated_by_admin_id) REFERENCES public.admins(admin_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: report_photos report_photos_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_photos
    ADD CONSTRAINT report_photos_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.reports(report_id) ON DELETE CASCADE;


--
-- Name: reports reports_assigned_by_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_assigned_by_admin_fk FOREIGN KEY (assigned_by_admin_id) REFERENCES public.admins(admin_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: reports reports_assigned_personnel_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_assigned_personnel_fk FOREIGN KEY (assigned_personnel_id) REFERENCES public.personnel_accounts(personnel_id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: trash_admin_notifications trash_admin_notifications_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_admin_notifications
    ADD CONSTRAINT trash_admin_notifications_fk FOREIGN KEY (resident_id, notification_id) REFERENCES public.admin_notifications(resident_id, notification_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trash_notifications trash_notifications_notification_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_notifications
    ADD CONSTRAINT trash_notifications_notification_fk FOREIGN KEY (notification_id) REFERENCES public.notifications(notification_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: admin_notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;

--
-- Name: archived_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.archived_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: password_reset_otps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.password_reset_otps ENABLE ROW LEVEL SECURITY;

--
-- Name: pending_registrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pending_registrations ENABLE ROW LEVEL SECURITY;

--
-- Name: report_histories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_histories ENABLE ROW LEVEL SECURITY;

--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: residents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.residents ENABLE ROW LEVEL SECURITY;

--
-- Name: trash_histories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trash_histories ENABLE ROW LEVEL SECURITY;

--
-- Name: trash_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trash_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: trash_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trash_reports ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict XzKjzeMGTAgRN1t5Axg8pvvqhdLIbteNRwa4PCM17vMMroMfLscrE4X10qqMMkt

