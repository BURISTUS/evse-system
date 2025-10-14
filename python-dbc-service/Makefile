.PHONY: install proto run test clean

install:
	pip install -r requirements.txt
	pip install grpcio-tools

proto:
	python setup.py

run:
	python main.py

test:
	python -m pytest tests/ -v

clean:
	rm -rf src/grpc/dbc_pb2*
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -name "*.pyc" -delete

dev: install proto run
