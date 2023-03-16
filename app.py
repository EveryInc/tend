from flask import Flask, request, send_from_directory
from rq import Queue
from worker import conn
from embed import embed_url
import os

os.environ['OBJC_DISABLE_INITIALIZE_FORK_SAFETY'] = 'YES'

app = Flask(__name__)
q = Queue(connection=conn)


@app.route('/<path:path>')
def serve_static(path):
  # Serve file from public directory
  return send_from_directory('public', path)

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

@app.route('/embed', methods=['POST'])
def embed_this():
    thing_to_embed, function = request.form.get('url'), embed_url
    metadata = request.form.get('metadata')
    job = q.enqueue(function, thing_to_embed, metadata)
    return 'OK', 200

if __name__ == '__main__':
    app.run()