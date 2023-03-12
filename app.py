from flask import Flask, request
from rq import Queue
from worker import conn
from embed import embed_url

app = Flask(__name__)
q = Queue(onnection=conn)

@app.route('/embed', methods=['POST'])
def embed_this():
    thing_to_embed, function = request.form.get('url'), embed_url
    metadata = request.form.get('metadata')
    job = q.enqueue(thing_to_embed, function, metadata)
    return 'OK', 200

if __name__ == '__main__':
    app.run()