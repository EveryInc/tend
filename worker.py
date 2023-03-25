import os
import redis
from rq import Worker, Queue, Connection
import multiprocessing
import time

os.environ['OBJC_DISABLE_INITIALIZE_FORK_SAFETY'] = 'YES'

listen = ['high', 'default', 'low']

redis_url = os.getenv('REDIS_URL', 'redis://localhost:6379')

conn = redis.from_url(redis_url)

def start_worker():
    with Connection(conn):
        worker = Worker(map(Queue, listen))
        worker.work()

if __name__ == '__main__':
    multiprocessing.Process(target=start_worker).start()
    time.sleep(10000)