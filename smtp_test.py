from flask import Flask
from flask_mail import Mail, Message

app = Flask(__name__)

app.config['MAIL_SERVER'] = "smtp.hostinger.com"
app.config['MAIL_PORT'] = 465
app.config['MAIL_USE_SSL'] = True
app.config['MAIL_USE_TLS'] = False
app.config['MAIL_USERNAME'] = "support@theralinkapp.com"
app.config['MAIL_PASSWORD'] = "TheraTest2025!"
app.config['MAIL_DEFAULT_SENDER'] = "support@theralinkapp.com"

mail = Mail(app)

with app.app_context():
    msg = Message("SMTP Test", recipients=["yourgmail@gmail.com"])
    msg.body = "SMTP Works!"
    mail.send(msg)
    print("Email sent!")
