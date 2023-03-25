from flask import Flask, request, send_from_directory
from rq import Queue
from worker import conn
from embed import embed_url
import os

os.environ['OBJC_DISABLE_INITIALIZE_FORK_SAFETY'] = 'YES'

app = Flask(__name__)
q = Queue(connection=conn)


def on_success(job, _):
    print(f"Job {job.id} completed successfully.")

def on_failure(job, exc_type, exc_value, traceback):
    print(f"Job {job.id} failed: {exc_value}")

@app.route('/<path:path>')
def serve_static(path):
  # Serve file from public directory
  return send_from_directory('public', path)

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

@app.route('/embed', methods=['POST'])
def embed_this():
    print("Got embedded request...")
    thing_to_embed, function = request.form.get('url'), embed_url
    metadata = request.form.get('metadata')
    print("Enqueuing...")
    job = q.enqueue(function, thing_to_embed, metadata, job_timeout=600)
    return 'OK', 200

if __name__ == '__main__':
    app.run()