import os
from datetime import datetime
import re
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
import smtplib
from email.message import EmailMessage
from sqlalchemy.schema import UniqueConstraint
from flask_migrate import Migrate
import stripe
from flask  import abort
from flask_login import current_user
from langdetect import detect


from dotenv import load_dotenv
from flask import (
    Flask, render_template, request, jsonify,
    session, redirect, url_for, flash
)
from groq import Groq
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin,
    login_user, logout_user,
    login_required, current_user
)
from werkzeug.security import generate_password_hash, check_password_hash
from authlib.integrations.flask_client import OAuth
from flask_mail import Mail
from itsdangerous import URLSafeTimedSerializer, SignatureExpired, BadSignature
from flask_mail import Message
from libretranslatepy import LibreTranslateAPI
import tempfile
import whisper 

# Path to your external .env file
env_path = r"C:\Users\Professsor\Desktop\therapyapp.env\.env"

# Load it
load_dotenv(env_path)



# ✅ Load model once when the server starts
#model = whisper.load_model("base")  # can also use "tiny", "small", "medium", "large"



# ========================================================================
# CONFIG
# ========================================================================
#load_dotenv()

# ========================================================================
# OPENAI CLIENT (GROQ)
# ========================================================================

# Detect environment
FLASK_ENV = os.getenv("FLASK_ENV", "production")


client = Groq(api_key=os.getenv("GROQ_API_KEY"))


# Load local Whisper only in development
if FLASK_ENV == "development":
    import whisper
    whisper_model = whisper.load_model("base")   # use "base" locally
else:
    whisper_model = None

MODEL = "llama-3.3-70b-versatile"   # or "llama-3.1-70b-versatile" if you want stronger model
user_sessions = {}

lt = LibreTranslateAPI("https://translate.argosopentech.com/")  # free public server

# translation Helper

def translate_text(text, target_lang):
    if not text.strip():
        return text
    try:
        return lt.translate(text, target_lang)
    except Exception as e:
        print("Translation error:", e)
        return text

def therapist_reply(user_id, session_id, user_message, user_lang="en"):
    print(f"[DEBUG] Detected language: {user_lang}")
    print(f"[DEBUG] Original message: {user_message}")

    if user_id not in user_sessions:
        user_sessions[user_id] = {}
    if session_id not in user_sessions[user_id]:
        user_sessions[user_id][session_id] = []

    # 1. Translate user message → English
    user_message_en = user_message
    if user_lang != "en":
        user_message_en = translate_text(user_message, "en")

    # Save user message
    user_sessions[user_id][session_id].append({"role": "user", "content": user_message_en})

    # 2. Build conversation
    messages = [{"role": "system", "content": THERAPIST_PROMPT}] + user_sessions[user_id][session_id]

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=0.75,
            max_tokens=350
        )
        reply_en = response.choices[0].message.content.strip()
    except Exception as e:
        print("[ERROR] Chat API error:", e)
        reply_en = "Sorry, something went wrong."

    # 3. Safeguard: avoid repetition
    prev_replies = [m["content"] for m in user_sessions[user_id][session_id] if m["role"] == "assistant"]
    if prev_replies and reply_en in prev_replies[-2:]:
        reply_en = "I hear you. What feels most important to share right now?"

    # Save assistant reply
    user_sessions[user_id][session_id].append({"role": "assistant", "content": reply_en})

    # 4. Translate back if needed
    if user_lang != "en":
        return translate_text(reply_en, user_lang)

    return reply_en


THERAPIST_PROMPT = """
You are a compassionate, emotionally intelligent therapist.

Your default role:
- Be therapeutic, empathetic, and reflective.
- First briefly reflect what the user is feeling.
- Then ask ONE thoughtful, open-ended question.
- Never lecture, never ask multiple questions.
- Keep replies short, warm, and natural (1–4 sentences).
- Always respond in the user’s language unless told otherwise.
- Match their tone: gentle if sad, steady if angry, calm if anxious, encouraging if hopeful.
- Avoid repeating the same sentence structure back-to-back.

But you are also adaptive:
- If the user directly asks for **advice, tips, or guidance**, switch from reflection to giving clear, practical, supportive answers. 
    - Provide short lists (2–5 tips max) if asked.
    - Balance empathy with usefulness. 
- If the user expresses emotions (e.g., “I feel depressed”, “I’m anxious”, “I’m angry”), focus fully on therapy:
    - Reflect feelings, validate them, and ask gentle questions.
- If the user asks a **general knowledge question** (not emotional), you may respond informatively like ChatGPT, but keep the tone supportive and conversational.
- If the user seems lost or stuck, you may offer gentle moral encouragement or principles (e.g., resilience, patience, kindness).

Always:
- Keep responses natural, human, and adaptive.
- Vary sentence structure (avoid sounding repetitive).
- Stay short: usually 2–4 sentences, unless tips or advice are requested.
"""

# ==================================
# Flask 
# ==================================

app = Flask(__name__)
app.secret_key = os.getenv(
    "SECRET_KEY",
    "2a62ca2fbe9226e0f0892d5762315c4e3490c1f096b968e9fc6d69cfd2533cf3"
)

used_reset_tokens = set()


# Configure Flask-Mail
app.config['MAIL_SERVER'] = os.getenv("MAIL_SERVER", "smtp.hostinger.com")
app.config['MAIL_PORT'] = int(os.getenv("MAIL_PORT", 465))
app.config['MAIL_USE_SSL'] = os.getenv("MAIL_USE_SSL", "true").lower() == "true"
app.config['MAIL_USE_TLS'] = os.getenv("MAIL_USE_TLS", "false").lower() == "true"
app.config['MAIL_USERNAME'] = os.getenv("MAIL_USERNAME")
app.config['MAIL_PASSWORD'] = os.getenv("MAIL_PASSWORD")  # ✅ no hardcoded password
app.config['MAIL_DEFAULT_SENDER'] = (
    "TheraLink Support",
    os.getenv("MAIL_DEFAULT_SENDER", "support@theralinkapp.com")
)

# Initialize Flask-Mail
mail = Mail(app)



# Stripe setup
stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
PUBLISHABLE_KEY = os.getenv("STRIPE_PUBLISHABLE_KEY")

# Token serializer (for password setup links)
serializer = URLSafeTimedSerializer(app.secret_key)

def generate_setup_token(email):
    return serializer.dumps(email, salt="setup-password")

def verify_setup_token(token, max_age=3600):  # token valid for 1 hour
    try:
        email = serializer.loads(token, salt="setup-password", max_age=max_age)
    except (SignatureExpired, BadSignature):
        return None
    return email



# Prevent caching everywhere (safe + simple); avoids back/forward reopening pages
@app.after_request
def add_header(response):
    # Strict cache rules to prevent back/forward button login bypass
    response.headers["Cache-Control"] = (
        "no-store, no-cache, must-revalidate, max-age=0, private, "
        "proxy-revalidate, s-maxage=0"
    )
    response.headers["Pragma"] = "no-cache"   # Legacy
    response.headers["Expires"] = "0"         # Expired immediately
    return response





# Database
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///therapy.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db = SQLAlchemy(app)
migrate = Migrate(app, db)

# Login manager
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "login"

# Redirect logged-in users away from auth pages (prevents back-button shenanigans)
@app.before_request
def check_user_access():
    if current_user.is_authenticated:
        # ✅ Allow primary admin full bypass
        if current_user.email == "support@theralinkapp.com":
            return

        # 1. Block login/signup/reset if already logged in
        protected_auth_endpoints = {
            "login", "signup", "reset_password_request", "reset_password"
        }
        if request.endpoint in protected_auth_endpoints:
            return redirect(url_for("dashboard"))

        # 2. Re-check user from DB (important in case admin deletes them mid-session)
        user = User.query.get(current_user.id)
        if not user:
            logout_user()
            session.clear()
            flash("❌ Your account no longer exists.", "error")
            return redirect(url_for("login"))

        # 3. Freeze logic: inactive users are logged out immediately
        if not user.is_subscribed:
            logout_user()
            session.clear()
            flash("⚠️ Your subscription is inactive. Please renew to continue.", "error")
            return redirect(url_for("login"))

#============================

#Admin Set_up

# ==========================

def admin_required(f):
    from functools import wraps
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated or current_user.email != "support@theralinkapp.com":
            abort(403)  # Forbidden
        return f(*args, **kwargs)
    return decorated_function


# === Grant Free Access ===
@app.route("/admin/grant_free/<int:user_id>", methods=["POST"])
@login_required
@admin_required
def grant_free_access(user_id):
    user = User.query.get_or_404(user_id)
    user.is_subscribed = True
    user.subscription_type = "free"
    db.session.commit()

    # Generate setup link
    token = generate_setup_token(user.email)
    link = url_for("set_password", token=token, _external=True)

    # Send email
    msg = Message(
        "TheraLink Free Access - Set Your Password",
        sender="support@theralinkapp.com",
        recipients=[user.email]
    )
    msg.body = f"""
    Hello,

    You have been granted free access to TheraLink.

    Please click the link below to set your password:
    {link}

    This link will expire in 1 hour.

    Best,
    TheraLink Team
    """

    # HTML version
    msg.html = f"""
<html>
  <body style="font-family: Arial, sans-serif; color: #333;">
    <h2 style="color: #0f2b23;">Welcome to <span style="color:#00ff9f;">TheraLink</span>!</h2>
    <p>Hello {user.email},</p>
    <p>You have been granted <strong>free access</strong> to TheraLink.</p>
    <p>Please click the button below to set your password:</p>
    <p style="text-align: center; margin: 30px 0;">
      <a href="{link}" style="background:#00ff9f; color:#0f2b23; padding:12px 20px; text-decoration:none; border-radius:6px; font-weight:bold;">
        Set Your Password
      </a>
    </p>
    <p><small>This link will expire in 1 hour.</small></p>
    <br>
    <p>Best regards,<br>TheraLink Team</p>
  </body>
</html>
"""
    mail.send(msg)

    flash(f"✅ Free access granted to {user.email}. Setup link sent via email.", "success")
    return redirect(url_for("dashboard"))



# === Add Group Access ===
@app.route("/admin/group_subscribe", methods=["POST"])
@login_required
@admin_required
def group_subscribe():
    try:
        emails = request.form.get("emails", "")
        group_name = request.form.get("group_name", "").strip()

        if not emails or not group_name:
            flash("Emails and group name are required.", "error")
            return redirect(url_for("admin_page"))

        email_list = [e.strip().lower() for e in emails.split(",") if e.strip()]
        for email in email_list:
            user = User.query.filter_by(email=email).first()
            if not user:
                # ✅ Create new user in pending state with temp password
                user = User(email=email)
                user.set_password(os.urandom(8).hex())  # random placeholder
                user.is_subscribed = False   # stays pending until setup
                user.subscription_type = "group"
                user.group_id = group_name
                user.status = "Pending"
                db.session.add(user)
                db.session.commit()
            else:
                user.subscription_type = "group"
                user.group_id = group_name
                db.session.commit()

            # ✅ Generate setup link for each user
            token = generate_setup_token(user.email)
            link = url_for("set_password", token=token, _external=True)

            # Send setup email
            msg = Message(
                "TheraLink Group Access - Set Your Password",
                sender="support@theralinkapp.com",
                recipients=[user.email]
            )
            msg.body = f"""
Hello,

You have been granted group access to TheraLink under '{group_name}'.

Please set your password using the link below:
{link}

This link will expire in 1 hour.

Best regards,
TheraLink Team
"""
            msg.html = f"""
<html>
  <body style="font-family: Arial, sans-serif; color: #333;">
    <h2 style="color:#0f2b23;">Welcome to <span style="color:#00ff9f;">TheraLink</span>!</h2>
    <p>Hello {user.email},</p>
    <p>You have been granted <strong>group access</strong> under <strong>{group_name}</strong>.</p>
    <p>Please click the button below to set your password:</p>
    <p style="text-align:center; margin:30px 0;">
      <a href="{link}" style="background:#00ff9f; color:#0f2b23; padding:12px 20px; text-decoration:none; border-radius:6px; font-weight:bold;">
        Set Your Password
      </a>
    </p>
    <p><small>This link will expire in 1 hour.</small></p>
    <br>
    <p>Best regards,<br>TheraLink Team</p>
  </body>
</html>
"""
            mail.send(msg)

        flash(f"✅ Group '{group_name}' created with {len(email_list)} users. Setup links sent.", "success")
        return redirect(url_for("admin_page"))

    except Exception as e:
        app.logger.exception("Error creating group subscription")
        flash("⚠️ Something went wrong while adding group subscriptions.", "error")
        return redirect(url_for("admin_page"))


# =======================================

#Stripe Set up

#===================

@app.route("/create-checkout-session", methods=["POST"])
@login_required  # 👈 require login
def create_checkout_session():
    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            mode="subscription",
            line_items=[{
                "price": "price_1S3oun9Z2P6yYsthvQydpeEN",  # 👈 use your $10 price ID
                "quantity": 1,
            }],
            customer_email=current_user.email,  # 👈 link session to your logged-in user
            success_url="https://theralinkapp.com/success",
            cancel_url="https://theralinkapp.com/cancel",
        )
        return jsonify({"id": checkout_session.id})
    except Exception as e:
        print("❌ Stripe error:", e)
        return jsonify(error=str(e)), 403



@app.route("/success")
def success():
    return "✅ Payment successful!"

@app.route("/cancel")
def cancel():
    return "❌ Payment canceled!"

# ========================================================================
# PASSWORD POLICY + RESET EMAIL
# ========================================================================
PASSWORD_REGEX = re.compile(r'^(?=.*[^A-Za-z0-9]).{6,}$')

def password_valid(pw: str) -> bool:
    return bool(PASSWORD_REGEX.match(pw or ""))

serializer = URLSafeTimedSerializer(app.secret_key)

def generate_reset_token(email: str) -> str:
    return serializer.dumps(email, salt="password-reset")

def verify_reset_token(token: str, max_age_seconds: int = 3600) -> str | None:
    try:
        return serializer.loads(token, salt="password-reset", max_age=max_age_seconds)
    except (BadSignature, SignatureExpired):
        return None

def send_reset_email(to_email: str, reset_link: str):
    host = os.getenv("MAIL_SERVER")
    port = int(os.getenv("MAIL_PORT", "587"))
    username = os.getenv("MAIL_USERNAME")
    password = os.getenv("MAIL_PASSWORD")
    use_tls = os.getenv("MAIL_USE_TLS", "true").lower() == "true"
    sender = os.getenv("MAIL_SENDER", "no-reply@theralink.local")

    subject = "Theralink password reset"
    body = (
        "Hi,\n\nUse the link below to reset your Theralink password. "
        "This link expires in 1 hour.\n\n"
        f"{reset_link}\n\n"
        "If you didn’t request this, you can ignore this email."
    )

    if not host or not username or not password:
        app.logger.warning("SMTP not configured; reset link:\n%s", reset_link)
        return

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to_email
    msg.set_content(body)

    with smtplib.SMTP(host, port) as s:
        if use_tls:
            s.starttls()
        s.login(username, password)
        s.send_message(msg)

# ========================================================================
# MODELS
# ========================================================================
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    
    # subscription fields
    is_subscribed = db.Column(db.Boolean, default=False)
    stripe_customer_id = db.Column(db.String(120), nullable=True)
    subscription_type = db.Column(db.String(50), default="stripe")  
    # "stripe", "free", "group"
    group_id = db.Column(db.String(120), nullable=True)  # for batch/university groups

    def set_password(self, password: str):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

class UserSession(db.Model):
    __tablename__ = "user_session"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    session_id = db.Column(db.String(120), nullable=False)
    name = db.Column(db.String(120), default="Session")
    messages = db.Column(db.JSON, default=[])
    kind = db.Column(db.String(20), nullable=False, server_default="chat")

    __table_args__ = (
        UniqueConstraint('user_id', 'session_id', 'kind', name='uq_user_session'),
    )

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


# ========================================================================
# TRIAL CONFIG
# ========================================================================
TRIAL_CHAT_LIMIT = 50
TRIAL_CALL_LIMIT_SECONDS = 5 * 60
TRIAL_CALL_MAX_SESSIONS = 5

# ========================================================================
# HOMEPAGE
# ========================================================================
@app.route("/")
def index():
    return render_template("index.html", publishable_key=PUBLISHABLE_KEY)

# ========================================================================
# GOOGLE OAUTH
# ========================================================================
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")

if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET:
    oauth = OAuth(app)
    google = oauth.register(
        name="google",
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        client_kwargs={"scope": "openid email profile"},
        token_endpoint_auth_method="client_secret_post",
    )

    @app.route("/auth/google")
    def auth_google():
        redirect_uri = url_for("auth_google_callback", _external=True)
        return google.authorize_redirect(redirect_uri)

    @app.route("/auth/google/callback")
    def auth_google_callback():
        try:
            token = google.authorize_access_token()
            userinfo = google.get("oauth2/v2/userinfo").json()
        except Exception:
            flash("Google sign-in failed.", "error")
            return redirect(url_for("login"))

        email = (userinfo or {}).get("email")
        if not email:
            flash("Google did not return an email address.", "error")
            return redirect(url_for("login"))

        user = User.query.filter_by(email=email.lower()).first()
        if not user:
            random_pw = os.urandom(16).hex()
            user = User(email=email.lower())
            user.set_password(random_pw)
            db.session.add(user)
            db.session.commit()

        login_user(user)
        flash("Logged in successfully with Google!", "success")
        return redirect(url_for("dashboard"))

# ========================================================================
# SIGNUP / LOGIN / LOGOUT
# ========================================================================
@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""

        if not email or not password:
            flash("Email and password are required.", "error")
            return redirect(url_for("signup"))

        if not password_valid(password):
            flash("Password must be at least 6 characters and include at least one special character.", "error")
            return redirect(url_for("signup"))

        if User.query.filter_by(email=email).first():
            flash("Email already registered.", "error")
            return redirect(url_for("login"))

        # 👉 Instead of creating user now, create checkout session
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=["card"],
             mode="subscription",
            line_items=[{
                 "price": "price_1S3oun9Z2P6yYsthvQydpeEN",  # your $10 price ID
                 "quantity": 1,
            }],
            customer_email=email,
            success_url="https://theralinkapp.com/payment_success?session_id={CHECKOUT_SESSION_ID}",
            cancel_url="https://theralinkapp.com/payment_failed",
        )
        return redirect(checkout_session.url, code=303)


    return render_template("signup.html")

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""

        user = User.query.filter_by(email=email).first()
        if user and user.check_password(password):
            # Admin can always log in
            if user.email == "support@theralinkapp.com":
                login_user(user)
                flash("Welcome, Admin!", "success")
                return redirect(url_for("admin_page"))

            # If subscription is frozen, send to Stripe checkout
            if not user.is_subscribed:
                flash("⚠️ Your subscription is inactive. Please renew to continue.", "error")

                # Create new Stripe checkout session
                checkout_session = stripe.checkout.Session.create(
                    payment_method_types=["card"],
                    mode="subscription",
                    line_items=[{
                        "price": "price_1S3oun9Z2P6yYsthvQydpeEN",  # your $10 price ID
                        "quantity": 1,
                    }],
                    customer_email=user.email,
                    success_url=url_for("reactivation_success", _external=True) + f"?email={user.email}",
                    cancel_url=url_for("index", _external=True),
                )

                # Redirect them directly to Stripe
                return redirect(checkout_session.url, code=303)

            # ✅ Normal successful login flow
            login_user(user)
            user.is_subscribed = True
            db.session.commit()

            flash("Logged in successfully!", "success")
            return redirect(url_for("dashboard"))

        else:
            flash("Invalid credentials", "error")

    return render_template("login.html")



# =====================

# Reactivation after freezig account

# ====================

@app.route("/reactivate", methods=["GET", "POST"])
@login_required
def reactivate():
    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            mode="subscription",
            line_items=[{
                "price": "price_1S3oun9Z2P6yYsthvQydpeEN",  # your live price ID
                "quantity": 1,
            }],
            customer_email=current_user.email,
            success_url="https://theralinkapp.com/reactivation_success?session_id={CHECKOUT_SESSION_ID}",
            cancel_url="https://theralinkapp.com/payment_failed",
        )
        return redirect(checkout_session.url, code=303)
    except Exception as e:
        app.logger.error(f"❌ Reactivation error: {e}")
        flash("⚠️ Could not start reactivation process. Please try again.", "error")
        return redirect(url_for("login"))



@app.route("/reactivation_success")
def reactivation_success():
    session_id = request.args.get("session_id")
    if not session_id:
        flash("Missing session details.", "error")
        return redirect(url_for("login"))

    # ✅ Retrieve the checkout session from Stripe
    checkout_session = stripe.checkout.Session.retrieve(session_id)
    email = checkout_session.customer_email
    customer_id = checkout_session.customer

    if not email:
        flash("Could not verify account.", "error")
        return redirect(url_for("login"))

    user = User.query.filter_by(email=email.lower()).first()
    if not user:
        flash("Account not found.", "error")
        return redirect(url_for("signup"))

    # ✅ Update subscription status
    user.is_subscribed = True
    user.subscription_type = "stripe"
    user.stripe_customer_id = customer_id
    db.session.commit()

    login_user(user)
    flash("🎉 Welcome back! Your subscription has been reactivated.", "success")
    return redirect(url_for("dashboard"))


# ======================
# LOGOUT (mark inactive)
# ======================
@app.route("/logout")
@login_required
def logout():
    current_user.status = "Inactive"
    db.session.commit()
    logout_user()
    session.clear()

    response = redirect(url_for("index"))
    response.headers["Clear-Site-Data"] = '"cache", "cookies", "storage", "executionContexts"'
    flash("✅ You have been logged out.", "info")
    return response



# ========================================================================
# PASSWORD RESET FLOW
# ========================================================================
@app.route("/reset-password", methods=["GET", "POST"])
def reset_password_request():
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        user = User.query.filter_by(email=email).first()
        if not user:
            flash("If that email exists, a reset link will be sent.", "info")
            return redirect(url_for("login"))

        token = generate_reset_token(email)
        reset_link = url_for("reset_password", token=token, _external=True)
        send_reset_email(email, reset_link)
        flash("Check your email for a password reset link.", "success")
        return redirect(url_for("login"))

    return render_template("reset_request.html")

@app.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token):
    email = verify_reset_token(token)
    if not email:
        flash("Reset link is invalid or has expired.", "error")
        return redirect(url_for("reset_password_request"))

    if request.method == "POST":
        new_pw = (request.form.get("password") or "").strip()
        if not password_valid(new_pw):
            flash("Password must be at least 6 characters and include at least one special character.", "error")
            return redirect(url_for("reset_password", token=token))

        user = User.query.filter_by(email=email.lower()).first()
        if not user:
            flash("Account not found.", "error")
            return redirect(url_for("signup"))

        user.set_password(new_pw)
        db.session.commit()

        flash("Your password has been reset successfully. Please log in.", "success")
        return redirect(url_for("login"))

    return render_template("reset_password.html", token=token)

# ========================================================================
# DASHBOARD
# ========================================================================
@app.route("/dashboard")
@login_required
def dashboard():
    if not current_user.is_authenticated:
        return redirect(url_for("login"))
    return render_template("dashboard.html")


# ========================================================================
# TRIAL CHAT
# ========================================================================
@app.route("/trial_chat")
def trial_chat():
    lang = request.args.get('lang', 'en')
    if "trial_chat_count" not in session:
        session["trial_chat_count"] = 0

    if session["trial_chat_count"] >= TRIAL_CHAT_LIMIT:
        flash("Your free trial has ended. Please sign up to continue.", "error")
        return redirect(url_for("signup"))

    return render_template("trial_chat.html", lang=lang)

@app.route("/trial_chat_message", methods=["POST"])
def trial_chat_message():
    # Track trial chat usage
    session["trial_chat_count"] = session.get("trial_chat_count", 0) + 1
    if session["trial_chat_count"] >= TRIAL_CHAT_LIMIT:
        return jsonify({"redirect": url_for("signup")})

    data = request.get_json()
    user_message = data.get("message", "")

    # ==== Persist trial_chat session if logged in ====
    if current_user.is_authenticated:
        trial_session = UserSession.query.filter_by(
            user_id=current_user.id,
            session_id="trial_chat",
            kind="trial_chat"
        ).first()
        if not trial_session:
            trial_session = UserSession(
                user_id=current_user.id,
                session_id="trial_chat",
                name="Trial Chat Session",
                messages=[],
                kind="trial_chat"
            )
            db.session.add(trial_session)

        trial_session.messages.append({"role": "user", "content": user_message})
        db.session.commit()

    # ==== Always English-only therapist logic ====
    conversation = [
        {"role": "system", "content": """
        You are a compassionate therapist.
        - Mirror the USER’s tone and mood.
        - First reflect their feelings, then ask ONE thoughtful, open-ended question.
        - Never lecture or ask multiple questions at once.
        - Keep replies short, empathetic, and natural.
        - 🚨 Always reply in ENGLISH, even if the user writes in another language.
        """},
        {"role": "user", "content": user_message}
    ]

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=conversation,
            temperature=0.8,
            max_tokens=400
        )
        reply = response.choices[0].message.content.strip()
    except Exception:
        app.logger.exception("Trial chat API error")
        reply = "Sorry, something went wrong."

    return jsonify({"reply": reply})



# ========================================================================
# TRIAL CALL
# ========================================================================
@app.route("/trial_call")
def trial_call():
    lang = request.args.get("lang", "en")
    session.setdefault("trial_call_sessions_left", TRIAL_CALL_MAX_SESSIONS)
    session.setdefault("trial_call_active_started_at", None)
    return render_template("trial_call.html", lang=lang)

@app.route("/trial_call/status")
def trial_call_status():
    if "trial_call_sessions_left" not in session:
        session["trial_call_sessions_left"] = TRIAL_CALL_MAX_SESSIONS
    if "trial_call_active_started_at" not in session:
        session["trial_call_active_started_at"] = None

    sessions_left = int(session["trial_call_sessions_left"])
    started_at = session["trial_call_active_started_at"]
    remaining = TRIAL_CALL_LIMIT_SECONDS

    if started_at:
        elapsed = int(datetime.now().timestamp() - int(started_at))
        remaining = max(0, TRIAL_CALL_LIMIT_SECONDS - elapsed)
        if remaining == 0:
            session["trial_call_active_started_at"] = None

    return jsonify({"remaining": remaining, "sessions_left": sessions_left})

@app.route("/trial_call/start", methods=["POST"])
def trial_call_start():
    sessions_left = int(session.get("trial_call_sessions_left", TRIAL_CALL_MAX_SESSIONS))
    started_at = session.get("trial_call_active_started_at")

    if started_at:
        elapsed = int(datetime.now().timestamp() - int(started_at))
        if elapsed < TRIAL_CALL_LIMIT_SECONDS:
            return jsonify({"ok": True, "sessions_left": sessions_left, "remaining": TRIAL_CALL_LIMIT_SECONDS - elapsed})

    if sessions_left <= 0:
        return jsonify({"ok": False, "error": "no_sessions_left", "sessions_left": 0, "remaining": 0}), 403

    session["trial_call_sessions_left"] = sessions_left - 1
    session["trial_call_active_started_at"] = int(datetime.now().timestamp())

    # ==== NEWLY ADDED/UPDATED: Persist trial_call session ====
    if current_user.is_authenticated:
        trial_call = UserSession.query.filter_by(
            user_id=current_user.id,
            session_id="trial_call",
            kind="trial_call"
        ).first()
        if not trial_call:
            trial_call = UserSession(
                user_id=current_user.id,
                session_id="trial_call",
                name="Trial Call Session",
                messages=[],
                kind="trial_call"
            )
            db.session.add(trial_call)
        db.session.commit()

    return jsonify({"ok": True, "sessions_left": session["trial_call_sessions_left"], "remaining": TRIAL_CALL_LIMIT_SECONDS})

# ========================================================================
# FULL CHAT
# ========================================================================
@app.route("/chat_page")
@login_required
def chat_page():
    if not current_user.is_authenticated:
        return redirect(url_for("login"))
    lang = request.args.get('lang', 'en')
    return render_template("chat.html", lang=lang)

@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json()
    user_id = str(data.get("user_id", "full_user"))
    session_id = str(data.get("session_id", "default"))
    message = data.get("message", "")
    user_lang = data.get("language", "en")

    # ==== Persist session if logged in ====
    if current_user.is_authenticated:
        chat_session = UserSession.query.filter_by(
            user_id=current_user.id,
            session_id=session_id,
            kind="chat"
        ).first()
        if not chat_session:
            chat_session = UserSession(
                user_id=current_user.id,
                session_id=session_id,
                name="Chat Session",
                messages=[],
                kind="chat"
            )
            db.session.add(chat_session)

        chat_session.messages.append({"role": "user", "content": message})
        db.session.commit()

    # ==== Adaptive Therapist Prompt ====
    conversation = [
        {
            "role": "system",
            "content": """
You are a compassionate, emotionally intelligent therapist and guide.

Your default role:
- Be therapeutic, empathetic, and reflective.
- Mirror the user’s tone and feelings.
- Ask one thoughtful, open-ended question to deepen their self-reflection.

But you are also adaptive:
- If the user directly asks for advice, tips, or guidance, switch from reflection to giving clear, practical, supportive answers.
  * Provide short lists (2–5 tips max) if asked.
  * Balance empathy with usefulness.
- If the user expresses emotions (e.g., “I feel depressed”, “I’m anxious”, “I’m angry”), focus fully on therapy:
  * Reflect feelings, validate them, and ask gentle questions.
- If the user asks a general knowledge question (not emotional), you may respond informatively like ChatGPT, but keep the tone supportive and conversational.
- If the user seems lost or stuck, you may offer gentle moral encouragement or principles (e.g., resilience, patience, kindness).

Always:
- Keep responses natural, human, and adaptive.
- Vary sentence structure to avoid repetition.
- Stay short: usually 2–4 sentences, unless tips or advice are requested.
- Always reply in the user’s language unless told otherwise.
- Always return structured answers in Markdown format when giving tips or advice.
- If the user explicitly asks for **tips, advice, or steps**, switch into **structured mode**:  
    * Provide a **numbered list or bullet points**.  
    * Keep each point short (1–2 sentences max).  
    * End with a reflective or open-ended question that encourages the user to engage with the advice.  

Examples of structured mode:
1. First tip here (short, clear).  
2. Second tip here.  
3. Third tip here.  
Which of these feels most relevant to you right now?
"""
        },
        {"role": "user", "content": message}
    ]

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=conversation,
            temperature=0.8,
            max_tokens=400
        )
        reply = response.choices[0].message.content.strip()
    except Exception:
        app.logger.exception("Chat API error")
        reply = "Sorry, something went wrong."

    return jsonify({"reply": reply})

# ========================================================================
# FULL CALL
# ========================================================================
@app.route("/call_page")
@login_required
def call_page():
    if not current_user.is_authenticated:
        return redirect(url_for("login"))
    lang = request.args.get("lang", "en")
    return render_template("call.html", lang=lang)


@app.route("/call", methods=["POST"])
def call():
    try:
        data = request.json
        user_id = data.get("user_id")
        session_id = data.get("session_id")
        user_message = data.get("message", "").strip()

        if not user_id or not session_id or not user_message:
            return jsonify({"error": "Missing required fields"}), 400

        if user_id not in user_sessions:
            user_sessions[user_id] = {}
        if session_id not in user_sessions[user_id]:
            user_sessions[user_id][session_id] = []

        # ✅ Handle call initialization
        if user_message == "__init__":
            # If no history yet → normal first greeting
            if not user_sessions[user_id][session_id]:
                welcome_msg = (
                    "Hi, I’m glad we’re starting this call. "
                    "What’s on your mind today?"
                )
            else:
                # Continue conversation with memory
                last_user_msg = None
                for msg in reversed(user_sessions[user_id][session_id]):
                    if msg["role"] == "user":
                        last_user_msg = msg["content"]
                        break

                if last_user_msg:
                    welcome_msg = (
                        f"Welcome back. Last time you mentioned '{last_user_msg}'. "
                        "Do you want to continue from there, or talk about something new today?"
                    )
                else:
                    welcome_msg = "Welcome back. Do you want to continue where we left off, or start fresh today?"

            return jsonify({"reply": welcome_msg, "session_id": session_id})

        # ✅ Normal conversation flow
        user_sessions[user_id][session_id].append({"role": "user", "content": user_message})

        system_prompt = """
        You are a compassionate, emotionally intelligent therapist.
        - Always reply in fluent English.
        - Keep your tone warm, empathetic, and conversational.
        - Keep responses short and meaningful (1–3 sentences).
        - Avoid bullet points, numbered lists, or structured formatting.
        - End with ONE thoughtful, open-ended question when possible.
        """

        conversation = [{"role": "system", "content": system_prompt}] + user_sessions[user_id][session_id]

        response = client.chat.completions.create(
            model=MODEL,
            messages=conversation,
            temperature=0.8,
            max_tokens=400
        )

        therapist_reply = response.choices[0].message.content.strip()
        user_sessions[user_id][session_id].append({"role": "assistant", "content": therapist_reply})

        return jsonify({"reply": therapist_reply, "session_id": session_id})

    except Exception:
        app.logger.exception("Call API error")
        return jsonify({"error": "Sorry, something went wrong with the call."}), 500

# ========================================================================
# AUTO-NAMING
# ========================================================================
@app.route("/chat/rename_session", methods=["POST"])
def rename_session():
    data = request.get_json()
    message = data.get("message", "")
    lang = data.get("language", "en")

    prompt = [
        {
            "role": "system",
            "content": (
                f"You are a helpful assistant. Generate a short, natural 2–4 word session title in {lang}. "
                f"If {lang} is not supported, return it in English. "
                f"Do NOT include quotes, punctuation, or explanations — just the title."
            )
        },
        {"role": "user", "content": message}
    ]

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=prompt,
            temperature=0.6,
            max_tokens=20
        )
        name = response.choices[0].message.content.strip()
        return jsonify({"name": name})
    except Exception:
        app.logger.exception("Rename error")
        return jsonify({"name": "Session"})

@app.route("/call/rename_session", methods=["POST"])
def rename_call_session():
    data = request.json
    messages = data.get("messages", [])

    prompt = (
        "You are an assistant that generates short, meaningful titles for therapy sessions. "
        "Summarize the emotional focus or main theme of this therapy session in 2–4 words. "
        "Use title case. Do not add quotes, explanations, or extra text.\n\n"
    )
    for msg in messages:
        role = "User" if msg["sender"] == "user" else "Therapist"
        prompt += f"{role}: {msg['text']}\n"

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.6,
            max_tokens=20
        )
        name = response.choices[0].message.content.strip().split("\n")[0]
        return jsonify({"name": name})
    except Exception:
        app.logger.exception("Call rename error")
        return jsonify({"name": "Unnamed Session"})
    

    # =================Trasribe Feature Route================================
@app.route("/transcribe", methods=["POST"])
def transcribe():
    try:
        if "audio" not in request.files:
            return jsonify({"error": "No audio uploaded"}), 400

        audio_file = request.files["audio"]

        if FLASK_ENV == "development":
            # 🔹 Local Whisper transcription
            import tempfile
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
                temp_path = tmp.name
                audio_file.save(temp_path)

            result = whisper_model.transcribe(temp_path)
            os.remove(temp_path)

            return jsonify({"text": result.get("text", "").strip()})
        else:
            # 🔹 Production → use Groq Whisper API
            transcript = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file.stream  # Flask stream → avoids temp save
            )
            return jsonify({"text": (transcript.text or "").strip()})

    except Exception as e:
        app.logger.exception("Transcription error")
        return jsonify({"error": f"Transcription failed: {str(e)}"}), 500



@app.route("/trial_transcribe", methods=["POST"])
def trial_transcribe():
    try:
        if "audio" not in request.files:
            return jsonify({"error": "No audio uploaded"}), 400

        audio_file = request.files["audio"]
        mimetype = (audio_file.mimetype or "").lower()
        size = getattr(audio_file, "content_length", None) or 0
        app.logger.info(f"📡 Upload: mimetype={mimetype}, size={size}")

        if size == 0:
            return jsonify({"text": ""})

        # 🔹 Pick extension based on mimetype
        ext = ".webm"
        if "mp4" in mimetype or "m4a" in mimetype:
            ext = ".mp4"
        elif "aac" in mimetype:
            ext = ".aac"
        elif "wav" in mimetype:
            ext = ".wav"

        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            temp_path = tmp.name
            audio_file.save(temp_path)

        file_size = os.path.getsize(temp_path)
        if file_size < 2000:  # ~2KB safeguard
            app.logger.warning(f"⚠️ File too small ({file_size} bytes), skipping transcription")
            os.remove(temp_path)
            return jsonify({"text": ""})

        app.logger.info(f"🎙️ Transcribing file: {temp_path}, size={file_size} bytes")

        # 🔹 Send to Whisper
        with open(temp_path, "rb") as f:
            transcript = client.audio.transcriptions.create(
                model="whisper-1",
                file=f
            )
        transcription = (transcript.text or "").strip()

        app.logger.info(f"✅ Transcription result: '{transcription}'")

        # Clean up
        if os.path.exists(temp_path):
            os.remove(temp_path)

        return jsonify({"text": transcription})

    except Exception as e:
        app.logger.exception(f"Trial transcription error: {str(e)}")
        return jsonify({"error": "Transcription failed"}), 500

@app.route("/debug_transcribe", methods=["POST"])
def debug_transcribe():
    """Simple endpoint to test if transcription works"""
    try:
        if "audio" not in request.files:
            return jsonify({"error": "No audio file"}), 400

        audio_file = request.files["audio"]

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            audio_file.save(tmp.name)

            with open(tmp.name, "rb") as f:
                transcript = client.audio.transcriptions.create(
                    model="whisper-1",
                    file=f
                )
            transcription = (transcript.text or "").strip()

            os.remove(tmp.name)

            return jsonify({
                "success": True,
                "text": transcription,
                "length": len(transcription)
            })

    except Exception as e:
        app.logger.exception("Debug transcription error")
        return jsonify({"error": str(e)}), 500

# ======Upload_audio======
@app.route("/call/upload_audio", methods=["POST"])
def upload_audio():
    try:
        audio_file = request.files["audio"]
        session_id = request.form.get("session_id")

        # Save temporary
        path = os.path.join("uploads", audio_file.filename)
        audio_file.save(path)

        # Transcribe with Whisper (or any STT model)
        transcript = client.audio.transcriptions.create(
            model="whisper-1",
            file=open(path, "rb")
        )

        return jsonify({"text": transcript.text})
    except Exception as e:
        app.logger.exception("Audio upload error")
        return jsonify({"error": str(e)}), 500

# ========================================================================
# SESSIONS (INCL. TRIAL) + SAVE/DELETE
# ========================================================================
@app.route("/sessions", methods=["GET"])
@login_required
def get_sessions():
    if not current_user.is_authenticated:
        return redirect(url_for("login"))
    try:
        sessions = UserSession.query.filter(
            UserSession.user_id == current_user.id,
            UserSession.kind.in_(["chat", "call", "trial_chat", "trial_call"])
        ).all()
        result = [
            {
                "session_id": s.session_id,
                "name": s.name,
                "messages": s.messages,
                "kind": s.kind,
            }
            for s in sessions
        ]
        return jsonify({"success": True, "sessions": result})
    except Exception:
        app.logger.exception("Error fetching sessions")
        return jsonify({"success": False, "message": "Could not fetch sessions"}), 500


@app.route("/session_status")
@login_required
def session_status():
    user = User.query.get(current_user.id)
    if not user or not user.is_subscribed:
        return jsonify({"active": False})
    return jsonify({"active": True})

# ==== NEWLY ADDED: Save Session ====
@app.route("/sessions/save", methods=["POST"])
@login_required
def save_session():
    if not current_user.is_authenticated:
        return redirect(url_for("login"))
    try:
        data = request.get_json()
        session_id = data.get("session_id")
        name = data.get("name")
        messages = data.get("messages", [])
        kind = data.get("kind")

        if not session_id or not kind:
            return jsonify({"success": False, "message": "Missing session_id or kind"}), 400

        # 🔹 Look up session by user_id + session_id + kind
        s = UserSession.query.filter_by(
            user_id=current_user.id,
            session_id=session_id,
            kind=kind
        ).first()

        if not s:
            # Create new session
            s = UserSession(
                user_id=current_user.id,
                session_id=session_id,
                kind=kind,
                messages=[]
            )
            db.session.add(s)

        if name:
            s.name = name
        if messages is not None:
            s.messages = messages

        db.session.commit()
        return jsonify({"success": True})
    except Exception:
        app.logger.exception("Error saving session")
        return jsonify({"success": False, "message": "Could not save session"}), 500

@app.route("/sessions/chat", methods=["GET"])
@login_required
def get_chat_sessions():
    sessions = UserSession.query.filter_by(
        user_id=current_user.id, kind="chat"
    ).all()
    return jsonify({"success": True, "sessions": [
        {"session_id": s.session_id, "name": s.name, "messages": s.messages, "kind": s.kind}
        for s in sessions
    ]})

@app.route("/sessions/call", methods=["GET"])
@login_required
def get_call_sessions():
    sessions = UserSession.query.filter_by(
        user_id=current_user.id, kind="call"
    ).all()
    return jsonify({"success": True, "sessions": [
        {"session_id": s.session_id, "name": s.name, "messages": s.messages, "kind": s.kind}
        for s in sessions
    ]})

# ==== NEWLY ADDED: Delete Session ====
@app.route("/sessions/delete", methods=["POST"])
@login_required
def delete_session():
    try:
        data = request.get_json()
        session_id = data.get("session_id")

        if not session_id:
            return jsonify({"success": False, "message": "Missing session_id"}), 400

        rows_deleted = UserSession.query.filter_by(
            user_id=current_user.id, session_id=session_id
        ).delete()
        db.session.commit()

        if rows_deleted == 0:
            return jsonify({"success": False, "message": "Session not found"}), 404

        return jsonify({"success": True, "message": "Session deleted"})
    except Exception as e:
        app.logger.exception("Error deleting session")
        return jsonify({"success": False, "message": "Could not delete session"}), 500


#======================================================
# TERMS & Privacy
#======================================================

@app.route("/terms")
def terms():
    return render_template("terms.html")

@app.route("/privacy")
def privacy():
    return render_template("privacy.html")


#=================================

# Payment

#=================================

@app.route("/payment_success")
def payment_success():
    session_id = request.args.get("session_id")
    if not session_id:
        flash("Missing session details.", "error")
        return redirect(url_for("signup"))

    # ✅ Retrieve checkout session from Stripe
    checkout_session = stripe.checkout.Session.retrieve(session_id)
    email = checkout_session.customer_email
    customer_id = checkout_session.customer

    # ✅ Create or update user
    user = User.query.filter_by(email=email).first()
    if not user:
        # Temporary random password (user can reset later)
        random_pw = os.urandom(12).hex()
        user = User(email=email, stripe_customer_id=customer_id)
        user.set_password(random_pw)
        user.is_subscribed = True
        db.session.add(user)
        db.session.commit()
        flash("Account created. Please reset your password from login.", "success")
    else:
        user.is_subscribed = True
        user.stripe_customer_id = customer_id
        db.session.commit()
        flash("Subscription active. You can log in now.", "success")

    return redirect(url_for("login"))


@app.route("/payment_failed")
def payment_failed():
    flash("Payment failed. Please try again.", "error")
    return redirect(url_for("signup"))


#======

#WEBHOOK

#======

@app.route("/webhook", methods=["POST"])
def stripe_webhook():
    payload = request.data
    sig_header = request.headers.get("Stripe-Signature")
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
    except Exception as e:
        app.logger.error(f"❌ Webhook error: {e}")
        return str(e), 400

    event_type = event["type"]
    app.logger.info(f"📩 Stripe Event Received: {event_type}")

    # === Checkout Completed (new subscription or renewal) ===
    if event_type == "checkout.session.completed":
        session_data = event["data"]["object"]
        email = session_data.get("customer_email") or (session_data.get("customer_details") or {}).get("email")
        customer_id = session_data.get("customer")

        if email:
            user = User.query.filter_by(email=email.lower()).first()
            if user:
                user.is_subscribed = True
                user.stripe_customer_id = customer_id
                db.session.commit()
                app.logger.info(f"🎉 Subscription activated for {email}")

    # === Invoice Paid (recurring billing success) ===
    elif event_type == "invoice.paid":
        invoice_data = event["data"]["object"]
        email = invoice_data.get("customer_email") or (invoice_data.get("customer_details") or {}).get("email")

        if email:
            user = User.query.filter_by(email=email.lower()).first()
            if user:
                user.is_subscribed = True
                db.session.commit()
                app.logger.info(f"✅ Subscription renewed for {email}")

    # === Payment Failed ===
    elif event_type == "invoice.payment_failed":
        invoice_data = event["data"]["object"]
        email = invoice_data.get("customer_email") or (invoice_data.get("customer_details") or {}).get("email")

        if email:
            user = User.query.filter_by(email=email.lower()).first()
            if user:
                user.is_subscribed = False
                db.session.commit()
                app.logger.warning(f"⚠️ Subscription frozen for {email}")

    # === Subscription Canceled ===
    elif event_type == "customer.subscription.deleted":
        sub_data = event["data"]["object"]
        customer_id = sub_data.get("customer")

        user = User.query.filter_by(stripe_customer_id=customer_id).first()
        if user:
            user.is_subscribed = False
            db.session.commit()
            app.logger.warning(f"❌ Subscription canceled for {user.email}")

    return "success", 200


@app.route("/renew_subscription")
@login_required
def renew_subscription():
    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            mode="subscription",
            line_items=[{
                "price": "price_1S3oun9Z2P6yYsthvQydpeEN",  # your live price ID
                "quantity": 1,
            }],
            customer_email=current_user.email,
            success_url="https://theralinkapp.com/reactivation_success?session_id={CHECKOUT_SESSION_ID}",
            cancel_url="https://theralinkapp.com/payment_failed",
        )
        return redirect(checkout_session.url, code=303)
    except Exception as e:
        app.logger.error(f"❌ Stripe renew error: {e}")
        flash("⚠️ Something went wrong while creating a renewal session.", "error")
        return redirect(url_for("login"))



# ==========================

# Cancel Subscription

# =========================

@app.route("/cancel_subscription", methods=["POST"])
@login_required
def cancel_subscription():
    try:
        # Prevent primary admin from being canceled
        if current_user.email == "support@theralinkapp.com":
            flash("⚠️ Primary admin cannot cancel subscription.", "error")
            return redirect(url_for("dashboard"))

        # Cancel Stripe subscription if exists
        if current_user.stripe_customer_id:
            subscriptions = stripe.Subscription.list(
                customer=current_user.stripe_customer_id,
                status="active",
                limit=1
            )
            if subscriptions.data:
                sub = subscriptions.data[0]
                stripe.Subscription.delete(sub.id)

        # ✅ Freeze account instead of deleting
        current_user.is_subscribed = False
        current_user.subscription_type = "canceled"
        db.session.commit()

        # Log them out
        logout_user()
        session.clear()

        flash("✅ Your subscription has been canceled. Your account is frozen, but your data is preserved.", "info")
        return redirect(url_for("index"))

    except Exception as e:
        app.logger.error(f"❌ Cancel subscription error: {e}")
        flash("⚠️ Something went wrong while canceling your subscription.", "error")
        return redirect(url_for("dashboard"))




# ==========================
# ADMIN PAGE
# ==========================
@app.route("/admin")
@login_required
def admin_page():
    if current_user.email != "support@theralinkapp.com":
        flash("You are not authorized to view this page.", "error")
        return redirect(url_for("dashboard"))

    users = User.query.all()
    return render_template("admin.html", users=users)


@app.route("/create_admin")
def create_admin():
    from werkzeug.security import generate_password_hash
    existing = User.query.filter_by(email=os.getenv("ADMIN_EMAIL")).first()
    if existing:
        return "Admin user already exists!"

    admin_password = os.getenv("ADMIN_PASSWORD")
    admin = User(
        email=os.getenv("ADMIN_EMAIL"),
        password_hash=generate_password_hash(admin_password),
        is_subscribed=True,
        subscription_type="free"
    )
    db.session.add(admin)
    db.session.commit()
    return f"✅ Admin user created: {os.getenv('ADMIN_EMAIL')}"




@app.route("/admin_login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""

        user = User.query.filter_by(email=email).first()
        if user and user.check_password(password) and user.email == os.getenv("ADMIN_EMAIL"):
            login_user(user)
            flash("Welcome, Admin!", "success")
            return redirect(url_for("admin_page"))  # goes to your admin.html
        else:
            flash("Invalid admin credentials.", "error")
            return redirect(url_for("admin_login"))

    return render_template("admin_login.html")


# ======================
# SET PASSWORD
# ======================
@app.route("/set_password/<token>", methods=["GET", "POST"])
def set_password(token):
    email = verify_setup_token(token)
    if not email:
        flash("⚠️ The setup link is invalid or expired.", "error")
        return redirect(url_for("login"))

    user = User.query.filter_by(email=email).first()
    if not user:
        flash("⚠️ User not found.", "error")
        return redirect(url_for("login"))

    if request.method == "POST":
        password = request.form.get("password")
        if not password or len(password) < 6:
            flash("⚠️ Password must be at least 6 characters long.", "error")
            return redirect(request.url)

        # Update password and activate user
        user.set_password(password)
        user.is_subscribed = True
        user.subscription_type = "free" if user.subscription_type == "pending" else user.subscription_type
        user.status = "Active"
        db.session.commit()

        flash("✅ Your password has been set. Please login.", "success")
        return redirect(url_for("login"))

    return render_template("set_password.html", token=token)
# ======================
# ADD INDIVIDUAL USER
# ======================
@app.route("/admin/add_user", methods=["POST"])
@login_required
@admin_required
def add_user():
    email = request.form.get("email").strip().lower()
    if not email:
        flash("⚠️ Email is required.", "error")
        return redirect(url_for("admin_page"))

    user = User.query.filter_by(email=email).first()
    if not user:
        # Create new user in PENDING state
        user = User(email=email)
        user.set_password(os.urandom(8).hex())  # temp password
        user.is_subscribed = False
        user.subscription_type = "pending"
        user.status = "Pending"
        db.session.add(user)
        db.session.commit()

    # Generate setup link
    token = generate_setup_token(user.email)
    link = url_for("set_password", token=token, _external=True)

    # Send setup email
    msg = Message("TheraLink Free Access - Set Your Password",
                  sender="support@theralinkapp.com",
                  recipients=[user.email])
    msg.body = f"""
Hello,

You've been granted access to TheraLink. Please set your password using the link below:

{link}

This link will expire in 1 hour.

Best regards,
TheraLink Support
"""
    mail.send(msg)

    flash(f"✅ Setup link sent to {user.email}", "success")
    return redirect(url_for("admin_page"))


# Prevent deleting or deactivating primary admin
PRIMARY_ADMIN_EMAIL = "support@theralinkapp.com"

@app.route("/admin/deactivate/<int:user_id>", methods=["POST"])
@login_required
@admin_required
def deactivate_user(user_id):
    user = User.query.get_or_404(user_id)
    if user.email == PRIMARY_ADMIN_EMAIL:
        flash("❌ You cannot deactivate the primary admin.", "error")
        return redirect(url_for("admin_page"))
    user.is_subscribed = False
    db.session.commit()
    flash(f"⚠️ {user.email} has been deactivated", "info")
    return redirect(url_for("admin_page"))

@app.route("/admin/delete/<int:user_id>", methods=["POST"])
@login_required
@admin_required
def delete_user(user_id):
    user = User.query.get_or_404(user_id)
    if user.email == PRIMARY_ADMIN_EMAIL:
        flash("❌ You cannot delete the primary admin.", "error")
        return redirect(url_for("admin_page"))

    db.session.delete(user)
    db.session.commit()

    flash(f"🗑️ {user.email} has been deleted", "info")
    return redirect(url_for("admin_page"))

# ========================================================================
# RUN
# ========================================================================
if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(host="0.0.0.0", port=5000, debug=True)
